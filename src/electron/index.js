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

// const fetch = require('electron-fetch').default
const FormData = require('form-data')


function getFilePluginUtil()
{
    // TODO: find better way to lookup this dependency
    // currently plugin is loaded twice, which is not intended behaviour
    return require('cordova-plugin-file/src/electron').util
}

/**
 * get absolute file path for given url (cdvfile://, efs://)
 * @param {string} url
 * @returns {string | null}
 */
function urlToFilePath(url)
{
    return getFilePluginUtil().urlToFilePath(url);
}

/**
 * @param {string} uri
 * @returns {Promise<EntryInfo>}
 */
function resolveLocalFileSystemURI(uri)
{
    return getFilePluginUtil().resolveLocalFileSystemURI(uri);
}

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
     * @param {CallbackContext} callbackContext
     */
    constructor(transactionId, state, abortCtrl, callbackContext)
    {
        this.transactionId = transactionId;
        this.state = state;
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
     * @param {any} content
     */
    constructor(size, code, content)
    {
        this.bytesSent = size;
        this.responseCode = code;
        this.response = content;
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


const fileTransferPlugin = {

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
     * @param {CallbackContext} callbackContext
     * @void
     */
    upload: function ([source, target, fileKey, fileName, mimeType, params, trustAllHosts, chunkedMode, headers, transactionId, httpMethod], callbackContext)
    {
        if (!checkURL(target))
            return callbackContext.error(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target));

        const filePath = urlToFilePath(source);
        if (!filePath)
            return callbackContext.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target));

        if (fileTransferOps[transactionId])
            return callbackContext.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target,
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

            // progress currently not supported
            fetch(target, {
                headers,
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
     * @param {CallbackContext} callbackContext
     * @void
     */
    download: function ([source, target, trustAllHosts, transactionId, headers], callbackContext)
    {
        if (!checkURL(source))
            return callbackContext.error(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target));

        const filePath = urlToFilePath(target);
        if (!filePath)
            return callbackContext.error(new FileTransferError(FileTransferError.FILE_NOT_FOUND_ERR, source, target));

        const parentPath = path.dirname(filePath);

        if (fileTransferOps[transactionId])
            return callbackContext.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target,
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
                    return transaction.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target,
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
                    return transaction.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target,
                        null, null, error));
                }

                try
                {
                    const res = await fetch(source, {
                        headers: headers || {},
                        method: 'GET',
                        signal: transaction.abortCtrl.signal
                    })

                    if (!res.ok)
                    {
                        if (res.status === 404)
                            return transaction.error(new FileTransferError(FileTransferError.INVALID_URL_ERR, source, target, res.status, res.body));
                        else
                            return transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, res.status, res.body));
                    }

                    /**
                     * @type {Readable}
                     */
                    const reader = res.body.getReader();
                    const contentLength = res.headers.has('Content-Length') ? +res.headers.get('Content-Length') : 0;
                    let receivedLength = 0;

                    while (true)
                    {
                        const {done, value} = await reader.read();
                        if (done)
                            break;

                        const buf  = Buffer.from(value);
                        await fs.write(fd, buf, 0, buf.length, receivedLength)
                        receivedLength += value.length;

                        if(!!contentLength)
                            transaction.progress({
                                lengthComputable: true,
                                loaded: receivedLength,
                                total: contentLength
                            })
                    }

                    // if(!contentLength)
                    //     transaction.progress({
                    //         lengthComputable: true,
                    //         loaded: receivedLength,
                    //         total: receivedLength
                    //     })

                    transaction.success(await resolveLocalFileSystemURI(target));

                } catch (error)
                {
                    console.error(error);
                    return transaction.error(new FileTransferError(FileTransferError.CONNECTION_ERR, source, target, null, null, error));
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
            return transaction.error(new FileTransferError(FileTransferError.ABORT_ERR, source, target,
                null, null, error));
        });
    },

    /**
     *
     * @param {string} transactionId
     * @param {CallbackContext} callbackContext
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
 * cordova electron plugin api
 * @param {string} action
 * @param {Array<any>} args
 * @param {CallbackContext} callbackContext
 * @returns {boolean} indicating if action is available in plugin
 */
const plugin = function (action, args, callbackContext)
{
    if (!fileTransferPlugin[action])
        return false;
    try
    {
        fileTransferPlugin[action](args, callbackContext)
    } catch (e)
    {
        console.error(action + ' failed', e);
        callbackContext.error({message: action + ' failed', cause: e});
    }
    return true;
}

// backwards compatibility: attach api methods for direct access from old cordova-electron platform impl
Object.keys(fileTransferPlugin).forEach((apiMethod) =>
{
    plugin[apiMethod] = (args) =>
    {
        return Promise.resolve((resolve, reject) =>
        {
            fileTransferPlugin[apiMethod](args, {
                progress: (data) =>
                {
                    console.warn("cordova-plugin-file-transfer: ignoring progress event as not supported in old plugin API", data);
                },
                success: (data) =>
                {
                    resolve(data)
                },
                error: (data) =>
                {
                    reject(data)
                }
            });
        });
    }
});


module.exports = plugin;
