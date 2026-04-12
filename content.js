(function() {
  if (window.__qqchess_content_loaded) return;
  window.__qqchess_content_loaded = true;

  var PAGE_SIZE = 50;
  var LIST_SIZE = 20;
  var lastLoadedGames = [];

  // 自动检测混淆后的属性名，避免每次天天象棋前端更新都需要手动修改
  var _fetchMethodName = null;
  var _listArrayName = null;

  function detectFetchMethod(qipuModel) {
    if (_fetchMethodName) return _fetchMethodName;
    var proto = Object.getPrototypeOf(qipuModel);
    var names = Object.getOwnPropertyNames(proto);
    for (var i = 0; i < names.length; i++) {
      var k = names[i];
      if (typeof qipuModel[k] === 'function') {
        try {
          if (qipuModel[k].toString().indexOf('TRequestGetDataList') !== -1) {
            _fetchMethodName = k;
            console.log('[QQChess Exporter] 检测到请求方法: ' + k);
            return k;
          }
        } catch (e) {}
      }
    }
    return null;
  }

  function detectListArray(qipuModel) {
    if (_listArrayName) return _listArrayName;
    var keys = Object.keys(qipuModel);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (Array.isArray(qipuModel[k]) && qipuModel[k].length > 0 &&
          qipuModel[k][0] && typeof qipuModel[k][0].qipuId !== 'undefined') {
        _listArrayName = k;
        console.log('[QQChess Exporter] 检测到列表数组: ' + k);
        return k;
      }
    }
    return null;
  }

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


  function fetchPage(qipuModel, pageNum) {
    var methodName = detectFetchMethod(qipuModel);
    if (!methodName) {
      console.error('[QQChess Exporter] 无法检测到请求对局列表的方法，天天象棋可能又更新了');
      return Promise.resolve([]);
    }

    return new Promise(function(resolve) {
      if (_listArrayName) {
        // 已检测到数组属性名，直接使用
        qipuModel[_listArrayName] = [];
        qipuModel[methodName](13, pageNum, PAGE_SIZE, 0);
        setTimeout(function() {
          resolve(qipuModel[_listArrayName] ? qipuModel[_listArrayName].slice() : []);
        }, 2000);
      } else {
        // 首次调用：先记录所有数组长度，请求后检测哪个数组被填充
        var arrayKeys = Object.keys(qipuModel).filter(function(k) {
          return Array.isArray(qipuModel[k]);
        });
        var before = {};
        arrayKeys.forEach(function(k) { before[k] = qipuModel[k].length; });

        qipuModel[methodName](13, pageNum, PAGE_SIZE, 0);

        setTimeout(function() {
          // 找到被填充的数组（长度增长且元素含 qipuId）
          for (var i = 0; i < arrayKeys.length; i++) {
            var k = arrayKeys[i];
            if (qipuModel[k].length > before[k] &&
                qipuModel[k][0] && typeof qipuModel[k][0].qipuId !== 'undefined') {
              _listArrayName = k;
              console.log('[QQChess Exporter] 检测到列表数组: ' + k);
              resolve(qipuModel[k].slice());
              return;
            }
          }
          resolve([]);
        }, 2000);
      }
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

            var metadata = {
              createTime: game.createTime,
              event: '',
              extPlayers: []
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
