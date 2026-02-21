(function() {
  var exportBtn = document.getElementById('exportBtn');
  var statusEl = document.getElementById('status');
  var totalCountEl = document.getElementById('totalCount');

  exportBtn.addEventListener('click', function() {
    exportBtn.disabled = true;
    statusEl.textContent = '正在获取对局列表...';

    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs[0]) {
        statusEl.textContent = '无法获取当前标签页';
        exportBtn.disabled = false;
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action: 'export' }, function(response) {
        if (chrome.runtime.lastError) {
          statusEl.textContent = '请先打开天天象棋网页版';
          exportBtn.disabled = false;
        }
      });
    });
  });

  chrome.runtime.onMessage.addListener(function(message) {
    if (!message || !message.type) return;

    if (message.type === 'QQCHESS_EXPORT_PROGRESS') {
      var p = message.payload;
      statusEl.textContent = p.message || ('正在导出 ' + p.current + '/' + p.total + ' ...');
    }

    if (message.type === 'QQCHESS_EXPORT_DONE') {
      var d = message.payload;
      if (d.count === 0) {
        statusEl.textContent = d.message || '没有找到对局';
      } else {
        var detail = '已导出 ' + d.count + ' 局';
        if (d.cached > 0) {
          detail += '（其中 ' + d.cached + ' 局来自缓存）';
        }
        statusEl.textContent = detail;
      }
      exportBtn.disabled = false;
    }

    if (message.type === 'QQCHESS_EXPORT_ERROR') {
      statusEl.textContent = '错误：' + message.payload.message;
      exportBtn.disabled = false;
    }
  });
})();
