/*
 *
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
 */

const path = require('path');
const fs = require('fs-extra');
const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
const http = require("http");
const https = require("https");
const undici = require("undici");
const {net, session} = require("electron");

// reduce bridge traffic
const PROGRESS_INTERVAL_MILLIS = 400;

const DOWNLOAD_ALGO = "net";


//https.globalAgent.options.ca = require('ssl-root-cas/latest').create();

// const fetch = require('electron-fetch').default
const FormData = require('form-data')


class FileTransferError
{
    /**
     *
     * @param {number} code
     * @param {string} source
     * @param {string} target
     * @param {number | null} [status = null]
     * @param {any} [body = null]
     * @param {any} [exception = null]
     */
    constructor(code, source, target, status = null, body = null, exception = null)
    {
        this.code = code;
        this.source = source;
        this.target = target;
        this.http_status = status;
        this.body = body;
        this.exception = exception;
    }
}

FileTransferError.FILE_NOT_FOUND_ERR = 1;
FileTransferError.INVALID_URL_ERR = 2;
FileTransferError.CONNECTION_ERR = 3;
FileTransferError.ABORT_ERR = 4;
FileTransferError.NOT_MODIFIED_ERR = 5;

class FileTransferOperation
{
    /**
     *
     * @param {string} transactionId
     * @param {number} state
     * @param {AbortController} abortCtrl
     * @param {CordovaElectronCallbackContext} callbackContext
     */
    constructor(transactionId, state, abortCtrl, callbackContext)
    {
        this.transactionId = transactionId;
        this.state = state;
        /**
         * @type {AbortController | null}
         */
        this.abortCtrl = abortCtrl;
        this.callbackContext = callbackContext;

        fileTransferOps[transactionId] = this;
    }

    error(error)
    {
        if (this.state !== FileTransferOperation.PENDING)
            return;
        this.callbackContext.error(error);
        this.state = FileTransferOperation.FAILED;
        if (this.abortCtrl)
        {
            this.abortCtrl.abort({message: "failed", cause: error});
            this.abortCtrl = null;
        }
        delete fileTransferOps[this.transactionId];
    }

    success(data)
    {
        if (this.state !== FileTransferOperation.PENDING)
            return;
        this.callbackContext.success(data);
        this.state = FileTransferOperation.DONE;
        delete fileTransferOps[this.transactionId];
    }

    progress(data)
    {
        if (this.state !== FileTransferOperation.PENDING)
            return;
        this.callbackContext.progress(data);
    }

    abort()
    {
        if (this.abortCtrl)
        {
            this.state = FileTransferOperation.CANCELLED;
            this.abortCtrl.abort("aborted");
            this.abortCtrl = null;
            delete fileTransferOps[this.transactionId];
        }
    }
}

FileTransferOperation.PENDING = 0;
FileTransferOperation.DONE = 1;
FileTransferOperation.CANCELLED = 2;
FileTransferOperation.FAILED = 3;


/**
 *
 * @type {Record<string, FileTransferOperation>}
 */
const fileTransferOps = {};


class FileUploadResult
{
    /**
     *
     * @param {number} size
     * @param {number} code
     * @param {any} response
     */
    constructor(size, code, response)
    {
        this.bytesSent = size;
        this.responseCode = code;
        this.response = response;
    }
}

function checkURL(url)
{
    return url.indexOf(' ') === -1;
}

function isNotFoundError(error)
{
    return !!(error && error.code === 'ENOENT');
}

/**
 *
 * @type {Record<string, (source:string, target:string, headers:Record<string | Array<string>>, trustAllHosts:boolean, fd:number, progress:(p:{lengthComputable:boolean, loaded:number, total:number})=>void, abortCtrl:AbortController)=>Promise<void>>}
 */
const DOWNLOAD_IMPLS = {
    'net':
        (source, target, headers, trustAllHosts, fd, progress, abortCtrl) =>
        {

            return new Promise((resolve, reject) =>
            {
                const req = net.request({
                    method: 'GET',
                    url: source,
                    session: session.fromPartition(''),
                    credentials: 'include'
                });

                if (headers)
                {
                    for (const name in headers)
                        req.setHeader(name, headers[name]);
                }

                // TODO: handle trustAllHosts

                abortCtrl.signal.addEventListener("abort", () =>
                {
                    req.abort();
                });


                req.on('response', (res) =>
                {

                    if (res.statusCode < 200 || res.statusCode >= 300)
                    {
                        if (res.statusCode === 404)
                            return reject(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target, res.statusCode, res));
                        else
                            return reject(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, res.statusCode, res));
                    }

                    const contentLength = res.headers['content-length'] ? +res.headers['content-length'] : 0;
                    let receivedLength = 0;
                    let nextProgress = 0;

                    let _aborted = false;

                    /**
                     * @type {Array<()=>Promise<void>>}
                     */
                    const _jobs = [];
                    /**
                     *
                     * @type {Promise<void> | null}
                     */
                    let _currentJob = null;

                    function startNextJob(force)
                    {
                        if (force || !_currentJob)
                        {
                            const next = _jobs.shift();
                            _currentJob = next ? next() : null;
                        }
                    }

                    /**
                     *
                     * @param {Buffer} chunk
                     */
                    function writeJob(chunk)
                    {
                        if (!_aborted)
                            _jobs.push(async () =>
                            {
                                if (_aborted)
                                    return startNextJob(true);

                                try
                                {
                                    const buf = Buffer.from(chunk);
                                    await fs.write(fd, buf, 0, buf.length, receivedLength)
                                    receivedLength += chunk.length;

                                    if (!!contentLength)
                                    {
                                        const now = Date.now();
                                        if (nextProgress < now)
                                        {
                                            nextProgress = now + PROGRESS_INTERVAL_MILLIS;
                                            progress({
                                                lengthComputable: true,
                                                loaded: receivedLength,
                                                total: contentLength
                                            })
                                        }
                                    }
                                } catch (error)
                                {
                                    errorJob(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, null, null, error));
                                }
                                startNextJob(true);
                            });

                        startNextJob(false);
                    }

                    function errorJob(error)
                    {
                        _aborted = true;
                        _jobs.length = 0;
                        _jobs.push(async () =>
                        {
                            await fs.write(fd, '', 0);
                            reject(error);
                        })
                        startNextJob(false);
                    }

                    function successJob()
                    {
                        if (!_aborted)
                        {
                            _jobs.push(async () =>
                            {
                                if (!_aborted) resolve();
                            })
                            startNextJob(false);
                        }
                    }


                    res.on('aborted', () =>
                    {
                        errorJob(new FileTransferError(FileTransferError.ABORT_ERR, source, target, null, null, null));
                    })
                    res.on('error', (error) =>
                    {
                        errorJob(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, null, null, error));
                    })
                    res.on('data', writeJob);
                    res.on('end', successJob);
                })
                req.on('error', (error) =>
                {
                    reject(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, null, null, error));
                })
                req.end()

            });


        },
    'undici':
        (source, target, headers, trustAllHosts, fd, progress, abortCtrl) =>
        {
            // ISSUES
            //  - undici.request ignores system/os trust store -> self-signed enterprise CA's won't work
            //  - how to apply OverrideUserAgent/AppendUserAgent ?
            return new Promise(async (resolve, reject) =>
            {
                try
                {
                    const agent = new undici.Agent({
                        connect: {
                            rejectUnauthorized: !trustAllHosts
                        }
                    });


                    const res = await undici.request(source, {
                        headers: headers || {},
                        method: 'GET',
                        signal: abortCtrl.signal,
                        dispatcher: agent
                    })

                    if (res.statusCode < 200 || res.statusCode >= 300)
                    {
                        if (res.statusCode === 404)
                            return reject(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target, res.statusCode, res));
                        else
                            return reject(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, res.statusCode, res));
                    }

                    const contentLength = res.headers['content-length'] ? +res.headers['content-length'] : 0;
                    let receivedLength = 0;
                    let nextProgress = 0;


                    for await (const data of res.body)
                    {
                        const buf = Buffer.from(data);
                        await fs.write(fd, buf, 0, buf.length, receivedLength)
                        receivedLength += data.length;

                        if (!!contentLength)
                        {
                            const now = Date.now();
                            if (nextProgress < now)
                            {
                                nextProgress = now + PROGRESS_INTERVAL_MILLIS;
                                progress({
                                    lengthComputable: true,
                                    loaded: receivedLength,
                                    total: contentLength
                                })
                            }
                        }
                    }
                    resolve();
                } catch (e)
                {
                    if (e instanceof undici.errors.RequestAbortedError) // see https://github.com/nodejs/undici/blob/main/docs/api/Dispatcher.md#example-2---aborting-a-request
                        reject(new FileTransferError(FileTransferError.ABORT_ERR, source, target, null, null, null));
                    else
                        reject(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, null, null, e));
                }
            });
        },
    'fetch':
        (source, target, headers, trustAllHosts, fd, progress, abortCtrl) =>
        {
            // ISSUES
            //  - fetch ignores system/os trust store -> self-signed enterprise CA's won't work
            //  - how to apply OverrideUserAgent/AppendUserAgent ?
            return new Promise(async (resolve, reject) =>
            {
                try
                {
                    const res = await fetch(source, {
                        headers: headers || {},
                        method: 'GET',
                        signal: abortCtrl.signal
                    })

                    if (!res.ok)
                    {
                        if (res.status === 404)
                            return reject(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target, res.status, res));
                        else
                            return reject(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, res.status, res));
                    }

                    /**
                     * @type {Readable}
                     */
                    const reader = res.body.getReader();
                    const contentLength = res.headers.has('Content-Length') ? +res.headers.get('Content-Length') : 0;
                    let receivedLength = 0;
                    let nextProgress = 0;
                    while (true)
                    {
                        const {done, value} = await reader.read();
                        if (done)
                            break;

                        const buf = Buffer.from(value);
                        await fs.write(fd, buf, 0, buf.length, receivedLength)
                        receivedLength += value.length;

                        if (!!contentLength)
                        {
                            const now = Date.now();
                            if (nextProgress < now)
                            {
                                nextProgress = now + PROGRESS_INTERVAL_MILLIS;
                                progress({
                                    lengthComputable: true,
                                    loaded: receivedLength,
                                    total: contentLength
                                })
                            }
                        }
                    }

                    resolve();
                } catch (e)
                {
                    // TODO: handle abort
                    // if (e instanceof DOMException) // see https://developer.mozilla.org/en-US/docs/Web/API/AbortController#examples
                    //     reject(new FileTransferError(FileTransferError.ABORT_ERR, source, target, null, null, null));
                    // else
                    reject(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, null, null, e));
                }
            });
        }

}


const pluginAPI = {

    /**
     * @param {string} source
     * @param {string} target
     * @param {string|null} fileKey
     * @param {string|null} fileName
     * @param {string|null} mimeType
     * @param {Record<string, string> | null} params
     * @param {boolean} trustAllHosts
     * @param {boolean} chunkedMode
     * @param {Record<string | Array<string>> | null} headers
     * @param {string} transactionId
     * @param {string|null} httpMethod
     * @param {CordovaElectronCallbackContext} callbackContext
     * @void
     */
    uploadFetch: function ([source, target, fileKey, fileName, mimeType, params, trustAllHosts, chunkedMode, headers, transactionId, httpMethod], callbackContext)
    {
        if (!checkURL(target))
            return callbackContext.error(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target));

        const filePath = _file_plugin_util.urlToFilePath(source);
        if (!filePath)
            return callbackContext.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target));

        if (fileTransferOps[transactionId])
            return callbackContext.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target,
                null, null, "transactionId " + transactionId + " already in use"));
        const transaction = fileTransferOps[transactionId] =
            new FileTransferOperation(transactionId, FileTransferOperation.PENDING, new AbortController(), callbackContext);


        fileKey = fileKey || 'file';
        fileName = fileName || 'image.jpg';
        mimeType = mimeType || 'image/jpeg';
        params = params || {};
        headers = headers || {};

        httpMethod = httpMethod && httpMethod.toUpperCase() === 'PUT' ? 'PUT' : 'POST';

        fs.stat(filePath).then((stats) =>
        {
            if (!stats.isFile())
                return transaction.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target,
                    null, null, "source is not a file"));

            const form = new FormData();
            form.append(
                fileKey,
                fs.readFileSync(filePath),
                {
                    contentType: mimeType,
                    filename: fileName,
                });
            Object.keys(params).forEach((key) =>
            {
                form.append(key, params[key]);
            })

            // ISSUES
            //  - system/os trust store
            //  - progress
            //  - how to apply OverrideUserAgent/AppendUserAgent ?
            fetch(target, {
                headers: form.getHeaders(headers),
                method: httpMethod,
                signal: transaction.abortCtrl.signal,
                body: form
            })
                .then((res) =>
                {
                    if (res.ok)
                        transaction.success(new FileUploadResult(stats.size, res.status, res.body))
                    else if (res.status === 404)
                        transaction.error(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target, res.status, res.body));
                    else
                        transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, res.status, res.body));
                }, (error) =>
                {
                    transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, null, null, error));
                })

        }, (error) =>
        {
            if (isNotFoundError(error))
                return transaction.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target));
            return transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target,
                null, null, error));
        })


    },

    /**
     * @param {string} source
     * @param {string} target
     * @param {string|null} fileKey
     * @param {string|null} fileName
     * @param {string|null} mimeType
     * @param {Record<string, string> | null} params
     * @param {boolean} trustAllHosts
     * @param {boolean} chunkedMode
     * @param {Record<string | Array<string>> | null} headers
     * @param {string} transactionId
     * @param {string|null} httpMethod
     * @param {CordovaElectronCallbackContext} callbackContext
     * @void
     */
    uploadXHR: function ([source, target, fileKey, fileName, mimeType, params, trustAllHosts, chunkedMode, headers, transactionId, httpMethod], callbackContext)
    {
        if (!checkURL(target))
            return callbackContext.error(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target));

        const filePath = _file_plugin_util.urlToFilePath(source);
        if (!filePath)
            return callbackContext.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target));

        if (fileTransferOps[transactionId])
            return callbackContext.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target,
                null, null, "transactionId " + transactionId + " already in use"));

        const xhr = new XMLHttpRequest();

        const transaction = fileTransferOps[transactionId] =
            new FileTransferOperation(transactionId, FileTransferOperation.PENDING, new AbortController(), callbackContext);

        transaction.abortCtrl.signal.addEventListener("abort", () =>
        {
            xhr.abort()
        });


        fileKey = fileKey || 'file';
        fileName = fileName || 'image.jpg';
        mimeType = mimeType || 'image/jpeg';
        params = params || {};
        headers = headers || {};

        httpMethod = httpMethod && httpMethod.toUpperCase() === 'PUT' ? 'PUT' : 'POST';

        // to make this configurable an additional api parameter (and options field) would be required
        xhr.withCredentials = false;

        fs.stat(filePath).then((stats) =>
        {
            if (!stats.isFile())
                return transaction.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target,
                    null, null, "source is not a file"));

            const form = new FormData();
            form.append(
                fileKey,
                fs.readFileSync(filePath),
                {
                    contentType: mimeType,
                    filename: fileName,
                });
            Object.keys(params).forEach((key) =>
            {
                form.append(key, params[key]);
            })

            // ISSUES
            //  - system/os trust store
            //  - how to apply OverrideUserAgent/AppendUserAgent ?

            xhr.open(httpMethod, target);

            for (const header in headers)
            {
                if (Object.prototype.hasOwnProperty.call(headers, header))
                {
                    xhr.setRequestHeader(header, headers[header]);
                }
            }

            xhr.onload = function ()
            {
                if (this.status >= 200 && this.status < 300)
                {
                    transaction.success(new FileUploadResult(stats.size, this.status, this.response));
                }
                else if (this.status === 404)
                {
                    transaction.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target))
                }
                else
                {
                    transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, this.status, this.response));
                }
            };

            xhr.ontimeout = function ()
            {
                transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, this.status, this.response));
            };

            xhr.onerror = function (error)
            {
                transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, this.status, this.response, error));
            };

            xhr.onabort = function ()
            {
                transaction.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target));
            };

            // xhr.upload not implemented
            if (xhr.upload)
                xhr.upload.onprogress = function (e)
                {
                    transaction.progress(e)
                };

            xhr.send(form);

        }, (error) =>
        {
            if (isNotFoundError(error))
                return transaction.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target));
            return transaction.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target,
                null, null, error));
        })


    },

    /**
     * @param {string} source
     * @param {string} target
     * @param {string|null} fileKey
     * @param {string|null} fileName
     * @param {string|null} mimeType
     * @param {Record<string, string> | null} params
     * @param {boolean} trustAllHosts
     * @param {boolean} chunkedMode
     * @param {Record<string | Array<string>> | null} headers
     * @param {string} transactionId
     * @param {string|null} httpMethod
     * @param {CordovaElectronCallbackContext} callbackContext
     * @void
     */
    upload: function ([source, target, fileKey, fileName, mimeType, params, trustAllHosts, chunkedMode, headers, transactionId, httpMethod], callbackContext)
    {
        if (!checkURL(target))
            return callbackContext.error(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target));

        const filePath = _file_plugin_util.urlToFilePath(source);
        if (!filePath)
            return callbackContext.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target));

        if (fileTransferOps[transactionId])
            return callbackContext.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target,
                null, null, "transactionId " + transactionId + " already in use"));

        let req;

        const transaction = fileTransferOps[transactionId] =
            new FileTransferOperation(transactionId, FileTransferOperation.PENDING, new AbortController(), callbackContext);


        transaction.abortCtrl.signal.addEventListener("abort", () =>
        {
            if (req)
            {
                req.destroy();
                req = null
            }
        });



        fileKey = fileKey || 'file';
        fileName = fileName || 'image.jpg';
        mimeType = mimeType || 'image/jpeg';
        params = params || {};
        headers = headers || {};

        trustAllHosts = !!trustAllHosts;

        httpMethod = httpMethod && httpMethod.toUpperCase() === 'PUT' ? 'PUT' : 'POST';

        let done = false

        fs.stat(filePath)
            .then((stats) =>
            {
                if (!stats.isFile())
                    return transaction.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target,
                        null, null, "source is not a file"));

                const form = new FormData();
                form.append(
                    fileKey,
                    fs.readFileSync(filePath),
                    {
                        contentType: mimeType,
                        filename: fileName,
                    });
                Object.keys(params).forEach((key) =>
                {
                    form.append(key, params[key]);
                })

                // TODO
                //  - system/os trust store ?
                //  - how to apply OverrideUserAgent/AppendUserAgent ?
                //  - send credentials/session cookies

                req = (target.startsWith("https:") ? https : http).request(target, {
                    method: httpMethod,
                    headers: form.getHeaders(headers),
                    rejectUnauthorized: trustAllHosts
                }, (res) =>
                {
                    done = true;

                    if (res.statusCode === 404)
                    {
                        return transaction.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target))
                    }
                    else if (res.statusCode < 200 || res.statusCode >= 300)
                    {
                        return transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, res.statusCode, res));
                    }

                    res.on('data', () =>
                    {
                        // ensure all chunks are read
                    });
                    res.on('end', () =>
                    {
                        transaction.success(new FileUploadResult(stats.size, res.statusCode, res));
                    });
                });

                req.on('error', (error) =>
                {
                    transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, null, null, error));
                })


                form.pipe(req);
                req.end();

                const progress = () =>
                {
                    if (done)
                        return;

                    if (req.connection && req.connection.bytesWritten)
                        callbackContext.progress({
                            lengthComputable: true,
                            loaded: req.connection.bytesWritten,
                            total: stats.size
                        })

                    setTimeout(progress, PROGRESS_INTERVAL_MILLIS);
                }
                req.on('socket', progress);

            }, (error) =>
            {
                if (isNotFoundError(error))
                    return transaction.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target));
                return transaction.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target,
                    null, null, error));
            })
            .catch((error) =>
            {
                return transaction.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target,
                    null, null, error));
            })
    },


    /**
     *
     * @param {string} source
     * @param {string} target
     * @param {boolean} trustAllHosts
     * @param {string} transactionId
     * @param {Record<string, string | Array<string>> | null} headers
     * @param {CordovaElectronCallbackContext} callbackContext
     * @void
     */
    download: function ([source, target, trustAllHosts, transactionId, headers], callbackContext)
    {
        if (!checkURL(source))
            return callbackContext.error(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target));

        const filePath = _file_plugin_util.urlToFilePath(target);
        if (!filePath)
            return callbackContext.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target));

        const parentPath = path.dirname(filePath);

        if (fileTransferOps[transactionId])
            return callbackContext.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target,
                null, null, "transactionId " + transactionId + " already in use"));
        const transaction = fileTransferOps[transactionId] =
            new FileTransferOperation(transactionId, FileTransferOperation.PENDING, new AbortController(), callbackContext);

        (async () =>
            {

                /**
                 * @type {Stats}
                 */
                let parentStats;
                try
                {
                    parentStats = await fs.stat(parentPath);
                    if (!parentStats.isDirectory())
                        return transaction.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target,
                            null, null, "target parent is not a directory"));
                } catch (error)
                {
                    if (isNotFoundError(error))
                        return transaction.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target));
                    return transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target,
                        null, null, error));
                }

                /**
                 * @type {number}
                 */
                let fd;
                try
                {
                    fd = await fs.open(filePath, 'w');
                } catch (error)
                {
                    return transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target,
                        null, null, error));
                }

                try
                {
                    await DOWNLOAD_IMPLS[DOWNLOAD_ALGO](source, target, headers, trustAllHosts, fd, transaction.progress.bind(transaction), transaction.abortCtrl)
                    transaction.success(await _file_plugin_util.resolveLocalFileSystemURI(target));
                } catch (error)
                {
                    console.error(error);
                    transaction.error(error);
                } finally
                {
                    if (fd)
                        fs.close(fd).catch((error) =>
                        {
                            console.error("cannot close", error);
                        });
                }
            }
        )
        ().catch((error) =>
        {
            transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target,
                null, null, error));
        });
    },

    /**
     *
     * @param {string} transactionId
     * @param {CordovaElectronCallbackContext} callbackContext
     * @void
     */
    abort:

        function ([transactionId], callbackContext)
        {
            const transaction = fileTransferOps[transactionId];
            if (transaction)
                transaction.abort();
            callbackContext.success()
        }
}

/**
 * @type {CordovaElectronPlugin}
 */
const plugin = function (action, args, callbackContext)
{
    if (!pluginAPI[action])
        return false;
    try
    {
        pluginAPI[action](args, callbackContext)
    } catch (e)
    {
        console.error(action + ' failed', e);
        callbackContext.error({message: action + ' failed', cause: e});
    }
    return true;
}

let _file_plugin_util;

plugin.initialize = async (ctx) =>
{
    _file_plugin_util = _file_plugin_util || (await ctx.getService('File')).util
}

module.exports = plugin;
