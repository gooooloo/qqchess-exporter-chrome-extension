(function() {
  if (window.__qqchess_content_loaded) return;
  window.__qqchess_content_loaded = true;

  var PAGE_SIZE = 50;
  var LIST_SIZE = 20;
  var lastLoadedGames = [];

  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'QQCHESS_EXPORT_REQUEST') {
      exportGames();
    }
    if (event.data && event.data.type === 'QQCHESS_LOAD_LIST_REQUEST') {
      loadGameList();
    }
    if (event.data && event.data.type === 'QQCHESS_EXPORT_SELECTED_REQUEST') {
      exportSelected(event.data.payload.qipuIds);
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


  // 用 Yj 请求一页，等 2 秒让 qgb 填满，然后读取
  function fetchPage(qipuModel, pageNum) {
    return new Promise(function(resolve) {
      qipuModel.qgb = [];
      qipuModel.Yj(13, pageNum, PAGE_SIZE, 0);
      // 等 2 秒让服务器返回完整数据
      setTimeout(function() {
        var results = [];
        if (qipuModel.qgb) {
          for (var i = 0; i < qipuModel.qgb.length; i++) {
            results.push(qipuModel.qgb[i]);
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
    } catch (e) {}
    if (!qipuModel) {
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
        sendDone({ count: finalResults.length, cached: cached, fetched: fetched, pgn: pgn, filename: filename });
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

          var metadata = {
            createTime: game.createTime,
            event: '',
            extPlayers: []
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

  function sendGameList(games) {
    window.postMessage({ type: 'QQCHESS_GAME_LIST', payload: { games: games } }, '*');
  }

  function parseResult(sData) {
    if (!sData) return '未知';
    var r = sData.result;
    if (r === '1-0') return '红胜';
    if (r === '0-1') return '黑胜';
    return '和棋';
  }

  function getPlayerNames(sData) {
    var userinfo = sData && sData.userinfo || {};
    return {
      redName: userinfo.redname || '红方',
      blackName: userinfo.blackname || '黑方'
    };
  }

  function loadGameList() {
    var qipuModel;
    try {
      qipuModel = fdk.getModel("QipuModel");
    } catch (e) {}
    if (!qipuModel) {
      sendError('无法获取 QipuModel，请确保在游戏页面中');
      return;
    }

    sendProgress({ message: '正在加载最近对局...' });

    fetchPage(qipuModel, 1).then(function(pageGames) {
      var games = pageGames.slice(0, LIST_SIZE);
      if (games.length === 0) {
        sendGameList([]);
        return;
      }

      var total = games.length;
      var CONCURRENCY = 5;
      var DELAY = 200;
      var loadedGames = new Array(total);
      var completed = 0;
      var nextIdx = 0;

      function onGameLoaded() {
        completed++;
        sendProgress({
          message: '正在加载 ' + completed + '/' + total + ' ...'
        });

        if (completed >= total) {
          lastLoadedGames = [];
          for (var i = 0; i < loadedGames.length; i++) {
            if (loadedGames[i]) lastLoadedGames.push(loadedGames[i]);
          }
          sendGameList(lastLoadedGames.map(function(g) {
            return {
              qipuId: g.qipuId,
              createTime: g.metadata.createTime,
              redName: g.redName,
              blackName: g.blackName,
              result: g.result
            };
          }));
        }
      }

      function processListGame(idx) {
        if (idx >= total) return;
        var game = games[idx];

        var cachedData = cacheGet(game.qipuId);
        if (cachedData) {
          var sData = cachedData.sData;
          var names = getPlayerNames(sData);
          loadedGames[idx] = {
            qipuId: game.qipuId,
            sData: sData,
            metadata: cachedData.metadata,
            redName: names.redName,
            blackName: names.blackName,
            result: parseResult(sData)
          };
          onGameLoaded();
          var next = nextIdx++;
          if (next < total) processListGame(next);
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

            var names = getPlayerNames(sData);
            loadedGames[idx] = {
              qipuId: game.qipuId,
              sData: sData,
              metadata: metadata,
              redName: names.redName,
              blackName: names.blackName,
              result: parseResult(sData)
            };
            onGameLoaded();

            sleep(DELAY).then(function() {
              var next = nextIdx++;
              if (next < total) processListGame(next);
            });
          })
          .catch(function(err) {
            console.error('Failed to fetch qipu ' + game.qipuId + ':', err);
            onGameLoaded();
            sleep(DELAY).then(function() {
              var next = nextIdx++;
              if (next < total) processListGame(next);
            });
          });
      }

      var initialBatch = Math.min(CONCURRENCY, total);
      nextIdx = initialBatch;
      for (var i = 0; i < initialBatch; i++) {
        processListGame(i);
      }
    });
  }

  function exportSelected(qipuIds) {
    var idSet = {};
    for (var i = 0; i < qipuIds.length; i++) {
      idSet[qipuIds[i]] = true;
    }

    var selected = [];
    for (var j = 0; j < lastLoadedGames.length; j++) {
      if (idSet[lastLoadedGames[j].qipuId]) {
        selected.push({ sData: lastLoadedGames[j].sData, metadata: lastLoadedGames[j].metadata });
      }
    }

    if (selected.length === 0) {
      sendError('没有找到选中的对局数据');
      return;
    }

    var pgn = window.QQChessPGN.generateMultiPGN(selected);
    var now = new Date();
    var filename = 'qqchess_' + now.getFullYear() +
      ('0' + (now.getMonth() + 1)).slice(-2) +
      ('0' + now.getDate()).slice(-2) + '.pgn';
    sendDone({ count: selected.length, pgn: pgn, filename: filename });
  }
})();
