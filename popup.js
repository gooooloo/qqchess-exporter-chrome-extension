(function() {
  var exportBtn = document.getElementById('exportBtn');
  var selectExportBtn = document.getElementById('selectExportBtn');
  var statusEl = document.getElementById('status');
  var gameListPanel = document.getElementById('gameListPanel');
  var gameListContainer = document.getElementById('gameListContainer');
  var selectAllCheckbox = document.getElementById('selectAll');
  var selectedCountEl = document.getElementById('selectedCount');
  var exportSelectedBtn = document.getElementById('exportSelectedBtn');

  var currentGames = [];

  function triggerDownload(content, filename) {
    // 发消息给 bridge.js，让它在页面 DOM 上触发下载（兼容 Safari）
    sendToTab({ action: 'download', pgn: content, filename: filename });
  }

  function sendToTab(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs[0]) {
        statusEl.textContent = '无法获取当前标签页';
        exportBtn.disabled = false;
        selectExportBtn.disabled = false;
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, message, function() {
        if (chrome.runtime.lastError) {
          statusEl.textContent = '请先打开天天象棋网页版';
          exportBtn.disabled = false;
          selectExportBtn.disabled = false;
        }
      });
    });
  }

  exportBtn.addEventListener('click', function() {
    exportBtn.disabled = true;
    selectExportBtn.disabled = true;
    gameListPanel.style.display = 'none';
    statusEl.textContent = '正在获取对局列表...';
    sendToTab({ action: 'export' });
  });

  selectExportBtn.addEventListener('click', function() {
    exportBtn.disabled = true;
    selectExportBtn.disabled = true;
    gameListPanel.style.display = 'none';
    statusEl.textContent = '正在加载最近对局...';
    sendToTab({ action: 'loadList' });
  });

  function formatDate(timestamp) {
    if (!timestamp) return '';
    var d = new Date(timestamp * 1000);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function getResultClass(result) {
    if (result === '红胜') return 'result-red';
    if (result === '黑胜') return 'result-black';
    if (result === '和棋') return 'result-draw';
    return '';
  }

  function updateSelectedCount() {
    var checkboxes = gameListContainer.querySelectorAll('input[type="checkbox"]');
    var count = 0;
    for (var i = 0; i < checkboxes.length; i++) {
      if (checkboxes[i].checked) count++;
    }
    selectedCountEl.textContent = '已选 ' + count + ' 局';
    exportSelectedBtn.textContent = '导出选中 (' + count + ')';
    exportSelectedBtn.disabled = count === 0;
    selectAllCheckbox.checked = count === checkboxes.length && count > 0;
  }

  function renderGameList(games) {
    games.sort(function(a, b) {
      return (b.createTime || 0) - (a.createTime || 0);
    });
    currentGames = games;
    gameListContainer.innerHTML = '';

    for (var i = 0; i < games.length; i++) {
      var game = games[i];
      var item = document.createElement('div');
      item.className = 'game-item';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.qipuId = game.qipuId;
      cb.addEventListener('change', updateSelectedCount);

      var dateSpan = document.createElement('span');
      dateSpan.className = 'game-date';
      dateSpan.textContent = formatDate(game.createTime);

      var playersSpan = document.createElement('span');
      playersSpan.className = 'game-players';
      playersSpan.textContent = game.redName + ' vs ' + game.blackName;

      var resultSpan = document.createElement('span');
      resultSpan.className = 'game-result ' + getResultClass(game.result);
      resultSpan.textContent = game.result;

      item.appendChild(cb);
      item.appendChild(dateSpan);
      item.appendChild(playersSpan);
      item.appendChild(resultSpan);

      item.addEventListener('click', function(e) {
        if (e.target.tagName !== 'INPUT') {
          var checkbox = this.querySelector('input[type="checkbox"]');
          checkbox.checked = !checkbox.checked;
          updateSelectedCount();
        }
      });

      gameListContainer.appendChild(item);
    }

    selectAllCheckbox.checked = true;
    updateSelectedCount();
  }

  selectAllCheckbox.addEventListener('change', function() {
    var checkboxes = gameListContainer.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < checkboxes.length; i++) {
      checkboxes[i].checked = selectAllCheckbox.checked;
    }
    updateSelectedCount();
  });

  exportSelectedBtn.addEventListener('click', function() {
    var checkboxes = gameListContainer.querySelectorAll('input[type="checkbox"]:checked');
    var qipuIds = [];
    for (var i = 0; i < checkboxes.length; i++) {
      qipuIds.push(checkboxes[i].dataset.qipuId);
    }
    if (qipuIds.length === 0) return;

    exportSelectedBtn.disabled = true;
    statusEl.textContent = '正在导出...';
    sendToTab({ action: 'exportSelected', qipuIds: qipuIds });
  });

  chrome.runtime.onMessage.addListener(function(message) {
    if (!message || !message.type) return;

    if (message.type === 'QQCHESS_EXPORT_PROGRESS') {
      var p = message.payload;
      statusEl.textContent = p.message || ('正在导出 ' + p.current + '/' + p.total + ' ...');
    }

    if (message.type === 'QQCHESS_GAME_LIST') {
      var games = message.payload.games;
      statusEl.textContent = '已加载 ' + games.length + ' 局';
      exportBtn.disabled = false;
      selectExportBtn.disabled = false;
      if (games.length === 0) {
        statusEl.textContent = '没有找到对局';
        return;
      }
      gameListPanel.style.display = 'block';
      renderGameList(games);
    }

    if (message.type === 'QQCHESS_EXPORT_DONE') {
      var d = message.payload;
      if (d.pgn && d.filename) {
        triggerDownload(d.pgn, d.filename);
      }
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
      selectExportBtn.disabled = false;
      exportSelectedBtn.disabled = false;
    }

    if (message.type === 'QQCHESS_EXPORT_ERROR') {
      statusEl.textContent = '错误：' + message.payload.message;
      exportBtn.disabled = false;
      selectExportBtn.disabled = false;
    }
  });
})();
