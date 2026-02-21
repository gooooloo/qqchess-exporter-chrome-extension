(function() {
  var PAGE_SIZE = 50;

  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'QQCHESS_EXPORT_REQUEST') {
      exportGames();
    }
  });

  function sendProgress(data) {
    window.postMessage({ type: 'QQCHESS_EXPORT_PROGRESS', payload: data }, '*');
  }

  function sendDone(data) {
    window.postMessage({ type: 'QQCHESS_EXPORT_DONE', payload: data }, '*');
  }

  function sendError(msg) {
    window.postMessage({ type: 'QQCHESS_EXPORT_ERROR', payload: { message: msg } }, '*');
  }

  function cacheGet(qipuId) {
    try {
      var raw = localStorage.getItem('qqchess_qipu_' + qipuId);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(qipuId, data) {
    try {
      localStorage.setItem('qqchess_qipu_' + qipuId, JSON.stringify(data));
    } catch (e) {}
  }

  function fetchQipuData(qipuModel, qipuId) {
    return new Promise(function(resolve, reject) {
      var origBa = qipuModel.ba;
      var timeoutId = setTimeout(function() {
        qipuModel.ba = origBa;
        reject(new Error('Timeout fetching qipu ' + qipuId));
      }, 15000);

      qipuModel.ba = function(eventName, data) {
        if (data && data.param && data.param.collectDataInfo &&
            data.param.collectDataInfo.lDataID == qipuId) {
          clearTimeout(timeoutId);
          qipuModel.ba = origBa;
          resolve(data.param.collectDataInfo);
          return;
        }
        if (data && data.collectData && data.collectData.lDataID == qipuId) {
          clearTimeout(timeoutId);
          qipuModel.ba = origBa;
          resolve(data.collectData);
          return;
        }
        origBa.call(qipuModel, eventName, data);
      };

      qipuModel.requestGetQipuInfo(String(qipuId), -1, false, 99, false, false);
    });
  }

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  function downloadBlob(content, filename) {
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // 用 Sj 请求一页，等 2 秒让 Beb 填满，然后读取
  function fetchPage(qipuModel, pageNum) {
    return new Promise(function(resolve) {
      qipuModel.Beb = [];
      qipuModel.Sj(13, pageNum, PAGE_SIZE, 0);
      // 等 2 秒让服务器返回完整数据
      setTimeout(function() {
        var results = [];
        if (qipuModel.Beb) {
          for (var i = 0; i < qipuModel.Beb.length; i++) {
            results.push(qipuModel.Beb[i]);
          }
        }
        resolve(results);
      }, 2000);
    });
  }

  function exportGames() {
    var qipuModel;
    try {
      qipuModel = fdk.getModel("QipuModel");
    } catch (e) {
      sendError('无法获取 QipuModel，请确保在游戏页面中');
      return;
    }

    sendProgress({ message: '正在获取对局列表...' });

    var allGames = [];
    var seenIds = {};
    var pageNum = 1;

    function loadNextPage() {
      fetchPage(qipuModel, pageNum).then(function(pageGames) {
        if (pageGames.length === 0) {
          finishLoading();
          return;
        }

        var newOnThisPage = 0;
        for (var i = 0; i < pageGames.length; i++) {
          var id = pageGames[i].qipuId;
          if (!seenIds[id]) {
            seenIds[id] = true;
            allGames.push(pageGames[i]);
            newOnThisPage++;
          }
        }

        sendProgress({ message: '已加载 ' + allGames.length + ' 局...' });

        if (newOnThisPage === 0 || pageGames.length < PAGE_SIZE) {
          finishLoading();
        } else {
          pageNum++;
          loadNextPage();
        }
      });
    }

    function finishLoading() {
      sendProgress({ message: '找到 ' + allGames.length + ' 局，开始导出...' });
      fetchAllDetails(qipuModel, allGames);
    }

    loadNextPage();
  }

  function fetchAllDetails(qipuModel, allGames) {
    var total = allGames.length;
    if (total === 0) {
      sendDone({ count: 0, message: '没有找到对局' });
      return;
    }

    var CONCURRENCY = 5;
    var DELAY = 200;
    var results = new Array(total);
    var cached = 0;
    var fetched = 0;
    var failed = 0;
    var completed = 0;
    var nextIdx = 0;

    function onComplete() {
      completed++;
      sendProgress({
        total: total,
        current: completed,
        message: '正在导出 ' + completed + '/' + total +
          (cached > 0 ? ' (' + cached + ' 局缓存)' : '') + ' ...'
      });

      if (completed >= total) {
        var finalResults = [];
        for (var i = 0; i < results.length; i++) {
          if (results[i]) finalResults.push(results[i]);
        }
        var pgn = window.QQChessPGN.generateMultiPGN(finalResults);
        var now = new Date();
        var filename = 'qqchess_' + now.getFullYear() +
          ('0' + (now.getMonth() + 1)).slice(-2) +
          ('0' + now.getDate()).slice(-2) + '.pgn';
        downloadBlob(pgn, filename);
        sendDone({ count: finalResults.length, cached: cached, fetched: fetched });
      }
    }

    function processGame(idx) {
      if (idx >= total) return;
      var game = allGames[idx];

      var cachedData = cacheGet(game.qipuId);
      if (cachedData) {
        results[idx] = { sData: cachedData.sData, metadata: cachedData.metadata };
        cached++;
        onComplete();
        var next = nextIdx++;
        if (next < total) processGame(next);
        return;
      }

      fetchQipuData(qipuModel, game.qipuId)
        .then(function(collectData) {
          var sData;
          try {
            sData = JSON.parse(collectData.sData);
          } catch (e) {
            sData = collectData.sData;
          }

          var extPlayers = [];
          if (game.$0a && game.$0a.Md && game.$0a.Md.val) {
            var vals = game.$0a.Md.val;
            for (var j = 0; j < vals.length; j++) {
              extPlayers.push(vals[j]);
            }
          }

          var metadata = {
            createTime: game.createTime,
            event: '',
            extPlayers: extPlayers
          };

          cacheSet(game.qipuId, { sData: sData, metadata: metadata });
          results[idx] = { sData: sData, metadata: metadata };
          fetched++;
          onComplete();

          sleep(DELAY).then(function() {
            var next = nextIdx++;
            if (next < total) processGame(next);
          });
        })
        .catch(function(err) {
          console.error('Failed to fetch qipu ' + game.qipuId + ':', err);
          failed++;
          onComplete();
          sleep(DELAY).then(function() {
            var next = nextIdx++;
            if (next < total) processGame(next);
          });
        });
    }

    var initialBatch = Math.min(CONCURRENCY, total);
    nextIdx = initialBatch;
    for (var i = 0; i < initialBatch; i++) {
      processGame(i);
    }
  }
})();
