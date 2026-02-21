(function() {
  // bridge.js — ISOLATED world
  // 桥梁脚本：连接 content.js (MAIN world) 和 popup.js (chrome API)

  // 监听来自 popup.js 的消息
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.action === 'export') {
      window.postMessage({ type: 'QQCHESS_EXPORT_REQUEST' }, '*');
      sendResponse({ ok: true });
    }
    if (message.action === 'loadList') {
      window.postMessage({ type: 'QQCHESS_LOAD_LIST_REQUEST' }, '*');
      sendResponse({ ok: true });
    }
    if (message.action === 'exportSelected') {
      window.postMessage({
        type: 'QQCHESS_EXPORT_SELECTED_REQUEST',
        payload: { qipuIds: message.qipuIds }
      }, '*');
      sendResponse({ ok: true });
    }
  });

  // 监听来自 content.js (MAIN world) 的 window.postMessage
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || !data.type) return;

    // storage GET 请求
    if (data.type === 'QQCHESS_STORAGE_GET') {
      chrome.storage.local.get(data.payload.key, function(result) {
        window.postMessage({
          type: 'QQCHESS_STORAGE_RESULT',
          reqId: data.reqId,
          payload: result
        }, '*');
      });
    }

    // storage SET 请求
    if (data.type === 'QQCHESS_STORAGE_SET') {
      var obj = {};
      obj[data.payload.key] = data.payload.value;
      chrome.storage.local.set(obj, function() {
        window.postMessage({
          type: 'QQCHESS_STORAGE_RESULT',
          reqId: data.reqId,
          payload: { ok: true }
        }, '*');
      });
    }

    // 转发进度/完成/错误消息给 popup
    if (data.type === 'QQCHESS_GAME_LIST') {
      chrome.runtime.sendMessage({
        type: data.type,
        payload: data.payload
      });
    }

    if (data.type === 'QQCHESS_EXPORT_PROGRESS' ||
        data.type === 'QQCHESS_EXPORT_DONE' ||
        data.type === 'QQCHESS_EXPORT_ERROR') {
      chrome.runtime.sendMessage({
        type: data.type,
        payload: data.payload
      });
    }
  });
})();
