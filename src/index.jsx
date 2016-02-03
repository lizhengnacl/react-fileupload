import React, {Component, PropTypes} from "react";
import EventEmitter from 'eventemitter3';

const defaultPropsReq = {
  url: '', // 文件上传服务器地址, 必须设置
  timeout: 0, // 超时时间(单位毫秒), 0为不限制超时时间
  data: null, // 上传时需要一起提交的数据
  headers: null, // 附加在request header上的键值对
  dataType: 'json', // 预期服务器返回的数据类型
  postType: 'form' // 上传方式
}

export default class extends Component {

  constructor() {
    super();

    // 上传文件队列
    this.queue = {
      succList: [], // 上传成功文件队列
      failList: [], // 上传失败文件队列
      waitList: [], // 等待上传的文件队列
      uploadingList: [] // 上传中的文件队列
    }
    this.fileIndex = 0; // 文件起始索引
    this.xhrList = []; // 缓存住xhr的队列，用来给abort使用

    this.onChange = this.onChange.bind(this);
    this.getAddedFileLength = this.getAddedFileLength.bind(this);
    this.bindDrop = this.bindDrop.bind(this);
    this.addFileFromClipboard = this.addFileFromClipboard.bind(this);
    this.addFiles = this.addFiles.bind(this);
    this.reset = this.reset.bind(this);
    this.abort = this.abort.bind(this);
    this.removeFile = this.removeFile.bind(this);
    this.eventEmitter = new EventEmitter();
  }

  static defaultProps = {
    cls: 'aloha-file-upload',
    style: {},
    req: defaultPropsReq,
    name: 'files[]', // 服务端接收文件的key
    accept: '*', // 资源类型
    maxSize: '5MB', // 文件大小限制
    maxFiles: -1, // 最大可上传文件数量，-1不限制
    maxWaitFiles: -1, // 最大允许等待上传的文件数量，-1不限制
    concurrent: 2, // 并发上传数量
    multiple: true, // 是否允许选择多文件上传
    disabled: false, // 组件是否禁用
    allowSameFile: true, // 一次上传操作后, 是否允许选择相同的文件继续上传
    uploadChecker: null, // 额外的上传检查, 返回true才会添加到上传队列中
    resultChecker: null, // 结果检查, 返回true才会触发上传的success事件
    events: null, // 组件事件对象

    /**
     * 通过componentWillReceiveProps来触发操作的属性
     */
    clipboardData: null, // 剪贴板数据, 更新该属性(传入event.clipboardData)可以触发上传事件
    files: null, // 上传的文件, 更新该属性, 传入files对象可以触发上传事件
    dropNode: null, // 拖拽组件节点, 更新该属性, 传入组件节点可以通过拖拽事件触发上传事件
    abortFileIndex: -1,
    removeFileIndex: -1
  }

  static propTypes = {
    cls: PropTypes.string,
    style: PropTypes.object,
    req: PropTypes.shape({
      url: PropTypes.string.isRequired,
      timeout: PropTypes.number,
      data: PropTypes.object,
      headers: PropTypes.object,
      dataType: PropTypes.oneOf(['json', 'text']),
      postType: PropTypes.oneOf(['', 'form', 'blob', 'buffer'])
    }),
    name: PropTypes.string,
    maxSize: PropTypes.string,
    maxFiles: PropTypes.number,
    maxWaitFiles: PropTypes.number,
    concurrent: PropTypes.number,
    multiple: PropTypes.bool,
    disabled: PropTypes.bool,
    allowSameFile: PropTypes.bool,
    uploadChecker: PropTypes.func,
    resultChecker: PropTypes.func,
    clipboardData: PropTypes.object,
    files: PropTypes.object,
    dropNode: PropTypes.object,
    abortFileIndex: PropTypes.number,
    removeFileIndex: PropTypes.number,
    events: PropTypes.object
  }

  componentWillReceiveProps(nextProps) {
    [
      ['clipboardData', 'addFileFromClipboard'],
      ['files', 'addFiles'],
      ['dropNode', 'bindDrop'],
      ['abortFileIndex', 'abort'],
      ['removeFileIndex', 'removeFile']
    ].forEach(([key, method]) => {
      nextProps[key] != this.props[key] && this[method](nextProps[key])
    })
  }

  componentDidMount() {
    var eventEmitter = this.eventEmitter, events = this.props.events;
    if(events) {
      Object.keys(events).forEach(name => eventEmitter.on(name, events[name]));
    }
  }

  // 已添加文件数量, 不计算上传失败的
  getAddedFileLength() {
    var queue = this.queue;
    return queue.succList.length + queue.waitList.length + queue.uploadingList.length;
  }

  // 添加文件
  addFiles(files) {
    var {disabled, maxFiles, maxWaitFiles, maxSize, uploadChecker, accept} = this.props;

    if(disabled) {
      console.warn('props disabled is true');
      return;
    }

    if (!files || !files.length || files.length == 0) {
      console.warn('params error in addFiles!');
      return;
    }

    // 最大上传数量限制
    if (maxFiles !== -1 && (files.length + this.getAddedFileLength() > maxFiles)) {
      this.eventEmitter.emit('overUploadLimit', files);
      return false;
    }

    var currMaxSize = helper.unit(maxSize),
        isCheckFileType = accept.indexOf('*') == -1,
        extArr = isCheckFileType ? accept.split(',') : [];
    for (let i = 0; i < files.length; i++) {
      let file = files[i], size = file.size;

      // 文件大小检测
      if (size == 0) {
        this.eventEmitter.emit('zeroFileSize', file);
        return false;
      } else if (size > currMaxSize) {
        this.eventEmitter.emit('overSizeLimit', file);
        return false;
      }

      // 文件后缀检测
      if(isCheckFileType) {
        if(file.name) {
          let ext = file.name.slice(file.name.lastIndexOf("."));
          if (extArr.indexOf(ext.toLowerCase()) == -1) {
            this.eventEmitter.emit('notAllow', file);
            return false;
          }
        } else if(file.type) { // 从剪贴板粘贴的没有file.name
          let ext = file.type.match(/\w+\/(\w+)/)[1];
          if (extArr.indexOf(ext.toLowerCase()) == -1) {
            this.eventEmitter.emit('notAllow', file);
            return false;
          }
        }
      }
    }

    // 最大等待上传数量限制
    if (maxWaitFiles !== -1 && maxWaitFiles < this.queue.waitList.length + files.length) {
      this.eventEmitter.emit('overWaitLimit', files);
      return false;
    }

    // 自定义检查
    if(typeof uploadChecker == 'function' && !uploadChecker()) {
      return false;
    }

    this.eventEmitter.emit('afterChecked', [...files]);

    // 添加到waitList
    for (let i = 0; i < files.length; i++) {
      let file = files[i];
      file.index = this.fileIndex++;
      file.sizeWithUnit = helper.convert(file.size);
      this.queue.waitList.push(file);
    }

    this.queue.waitList.length && this.upload();

    return true;
  }

  // 上传
  upload() {
    var self = this, queue = this.queue, eventEmitter = this.eventEmitter, xhrList = this.xhrList;
    var {disabled, name, concurrent, resultChecker} = this.props;
    var req = Object.assign(defaultPropsReq, this.props.req);

    if(disabled) {
      console.warn('props disabled is true');
      return;
    }

    if (queue.uploadingList.length >= concurrent) {
      return;
    }

    var file = queue.waitList.shift();
    if (file) {
      var xhr = new XMLHttpRequest();

      // 完成上传后的处理,包括超时和异常后
      var complete = function (file) {
        helper.del(file.index, queue.uploadingList);
        delete xhrList[file.index]

        if (queue.waitList.length == 0 && queue.uploadingList.length == 0) {
          eventEmitter.emit('finish', queue.succList, queue.failList);
        } else {
          self.upload();
        }
      };

      queue.uploadingList.push(file);
      xhrList[file.index] = xhr;

      xhr.onloadstart = () => {eventEmitter.emit('start', file)};

      xhr.upload.addEventListener('progress', function (e) {
        eventEmitter.emit('progress', e.loaded, e.total, parseInt(e.loaded * 100 / e.total), file);
      }, false);

      xhr.onload = function () {
        var result = xhr.responseText;
        try {
          var flag = true;
          if (req.dataType == 'json') {
            result = JSON.parse(xhr.responseText);
          }

          if(typeof resultChecker == 'function') {
            flag = resultChecker(result) !== false;
          }

          if (flag) {
            eventEmitter.emit('success', result, file);
            queue.succList.push(file);
          } else {
            eventEmitter.emit('error', result, file);
            queue.failList.push(file);
          }
        } catch (e) {
          eventEmitter.emit('error', e, file);
          queue.failList.push(file);
        } finally {
          complete(file);
        }
      };

      xhr.onerror = function (e) {
        eventEmitter.emit('error', e, file);
        queue.failList.push(file);
        complete(file);
      };

      xhr.timeout = req.timeout;
      xhr.ontimeout = function (e) {
        eventEmitter.emit('timeout', e, file);
        queue.failList.push(file);
        complete(file);
      };

      xhr.open('POST', req.url, true);

      if (req.postType === 'form') {
        var formData = new FormData();
        for (var key in req.data) { // 附加表单字段
          formData.append(key, req.data[key]);
        }
        formData.append(name, file);
        xhr.send(formData);

        // request header附加字段
        if (req.headers) {
          for (var key in req.headers) {
            xhr.setRequestHeader(key, req.headers[key]);
          }
        }
        if (file.headers) {
          for (var key in file.headers) {
            xhr.setRequestHeader(key, file.headers[key]);
          }
        }
      } else {
        xhr.setRequestHeader(name, file.name); // 提供给服务端的file name
        for (var key in req.data) { // 附加字段
          xhr.setRequestHeader(key, req.data[key]);
        }
        if (req.postType === 'blob') {
          var BlobBuilder = window.MozBlobBuilder || window.WebKitBlobBuilder || window.MSBlobBuilder || window.BlobBuilder;
          var bb = new BlobBuilder(), blob;
          bb.append(file);
          blob = bb.getBlob();
          xhr.send(blob);
        } else if (req.postType === 'buffer') {
          var reader = new FileReader();
          reader.readAsArrayBuffer(file);
          reader.onload = function () {
            xhr.send(this.result);
          };
        } else {
          xhr.send(file);
        }
      }

      this.upload();
    }
  }

  // 删除添加的文件
  removeFile(index) {
    this.abort(index);
    helper.del(index, this.queue.waitList);
    helper.del(index, this.queue.succList);
    helper.del(index, this.queue.failList);
  }

  // 中止上传
  abort(index) {
    var xhr = this.xhrList[+index]
    if (xhr) {
      helper.del(+index, this.queue.uploadingList);
      xhr.abort();
      delete this.xhrList[index];
      this.upload();
      return true;
    }
    return false;
  }

  // 重置
  reset() {
    var queue = this.queue;
    queue.succList.length = 0;
    queue.failList.length = 0;
    queue.waitList.length = 0;
    queue.uploadingList.length = 0;
  }

  onChange(e) {
    var files = e.currentTarget.files;
    !this.props.disabled && this.addFiles(files);
    this.props.allowSameFile && this.refs.form.reset();
  }

  // 从剪贴板添加上传文件
  addFileFromClipboard(clp) {
    // 剪切板图片
    if (clp.types.length === 1 && clp.types[0] === "Files" && clp.items.length === 1 &&
      clp.items[0].kind === "file" && clp.items[0].type.match(/^image\//i)) {
      var pasteFile = clp.items[0].getAsFile();
      this.addFiles([pasteFile]);
    }

    // 电子表格转化为图片
    if (clp.types.length === 4 && clp.types[3] === "Files" && clp.items.length === 4 &&
      clp.items[3].kind === "file" && clp.items[3].type.match(/^image\//i)) {
      var pasteFile = clp.items[3].getAsFile();
      this.addFiles([pasteFile]);
    }
  }

  // 给支持拖拽上传的节点绑定事件
  bindDrop(dropNode) {
    if (!dropNode || dropNode.nodeType != 1) {
      console.warn('params error!');
      return;
    }

    var self = this;
    if (dropNode) {
      // 从拖拽获得文件
      dropNode.addEventListener("dragenter", function (e) {
        e.preventDefault();
      }, false);
      dropNode.addEventListener("dragover", function (e) {
        e.dataTransfer.dropEffect = 'copy'; // 兼容圈点APP
        e.preventDefault();
      }, false);
      dropNode.addEventListener("dragleave", function (e) {
        // 圈点APP的拖拽只会有这个事件 没有drop事件
        e.preventDefault();
      });
      dropNode.addEventListener("drop", function (e) {
        e.preventDefault();
        var df = e.dataTransfer;
        var dropFiles = [];

        if (df.items !== undefined) {
          // Chrome 不让文件夹上传
          for (var i = 0; i < df.items.length; i++) {
            // Chrome 不让文件夹上传
            var item = df.items[i];
            if (item.kind === "file" && item.webkitGetAsEntry().isFile) {
              var file = item.getAsFile();
              dropFiles.push(file);
            }
          }
        } else {
          // Safari 文件夹问题暂时先不解决 是为了防止用户上传没有后缀的文件会失败
          for (var i = 0; i < df.files.length; i++) {
            dropFiles.push(df.files[i]);
          }
        }

        self.addFiles(dropFiles)
      }, false);
    }
  }

  render() {
    let {name, cls, style, accept, multiple} = this.props;
    return (
      <form ref="form" className={cls} style={style}>
        <input type="file" name={name} onChange={this.onChange} accept={accept} multiple={multiple}/>
      </form>
    )
  }
}

var helper = {
  unit: function (str) {
    var s = str.trim().replace(/\d+/, '').toUpperCase();
    var d = str.trim().replace(/\D+/g, '');
    var a = ['B', 'KB', 'MB', 'GB', 'TB'];
    var n = 0;
    for (var i = 0, len = a.length; i < len; i++) {
      if (s === a[i]) {
        n = i;
        break;
      }
    }
    return d * Math.pow(1024, n);
  },
  convert: function (size) {
    var a = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    var c = function (s) {
      i++;
      return s / 1024
    }

    while (size > 1024) {
      size = c(size);
    }

    return Math.round(size * 100) / 100 + a[i];
  },
  search: function (index, arr) {
    for (var i = 0; i < arr.length; i++) {
      if (+index === +arr[i].index) {
        return i;
      }
    }
    return -1;
  },
  del: function (index, arr) {
    var i = helper.search(index, arr);
    if (i !== -1) {
      return arr.splice(i, 1)[0];
    }
  }
}