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

  // 详情响应经 Model 的事件分发方法回来（历史: ba→sa），名字同样会被混淆器重排，运行时识别。
  // 识别签名: 4 个形参、函数体内含 this.<X>.<自身名>(参1,参2,参3) 的三参转发调用。
  var _dispatchMethodName = null;
  var _dispatchHookInstalled = false;
  var _pendingQipuResolvers = {};

  function collectFunctionNames(obj) {
    var seen = {};
    var names = [];
    var o = obj;
    while (o && o !== Object.prototype) {
      var keys = Object.getOwnPropertyNames(o);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (seen[k]) continue;
        seen[k] = true;
        try {
          if (typeof obj[k] === 'function') names.push(k);
        } catch (e) {}
      }
      o = Object.getPrototypeOf(o);
    }
    return names;
  }

  function detectDispatchMethod(qipuModel) {
    try {
      var funcs = collectFunctionNames(qipuModel);
      var esc = function(t) { return t.replace(/\$/g, '\\$'); };
      for (var i = 0; i < funcs.length; i++) {
        var k = funcs[i];
        try {
          var fn = qipuModel[k];
          if (fn.length !== 4) continue;
          var s = fn.toString();
          var m = s.match(/^function\s*[\w$]*\s*\(([^)]*)\)/);
          if (!m) continue;
          var params = m[1].split(',').map(function(p) { return p.trim(); });
          if (params.length !== 4) continue;
          var re = new RegExp('this\\.[\\w$]+\\.' + esc(k) + '\\(' +
            esc(params[0]) + ',' + esc(params[1]) + ',' + esc(params[2]) + '\\)');
          if (re.test(s)) return k;
        } catch (e) {}
      }
    } catch (e) {}
    // 兜底：直接试历史名字
    if (typeof qipuModel.sa === 'function') return 'sa';
    if (typeof qipuModel.ba === 'function') return 'ba';
    return null;
  }

  function extractCollectData(data) {
    if (data && data.param && data.param.collectDataInfo &&
        typeof data.param.collectDataInfo.lDataID !== 'undefined') {
      return data.param.collectDataInfo;
    }
    if (data && data.collectData && typeof data.collectData.lDataID !== 'undefined') {
      return data.collectData;
    }
    return null;
  }

  // 常驻的单个共享 hook，按 lDataID 分发给等待中的 fetch。
  // 不能每次 fetch 各自 patch/restore：并发时先返回的 restore 会把后装的 hook 挤掉，导致对方超时。
  function installDispatchHook(qipuModel) {
    if (_dispatchHookInstalled) return true;
    if (!_dispatchMethodName || typeof qipuModel[_dispatchMethodName] !== 'function') {
      _dispatchMethodName = detectDispatchMethod(qipuModel);
    }
    if (!_dispatchMethodName) return false;

    var orig = qipuModel[_dispatchMethodName];
    qipuModel[_dispatchMethodName] = function(eventName, data) {
      var info = extractCollectData(data);
      if (info) {
        var key = String(info.lDataID);
        var resolver = _pendingQipuResolvers[key];
        if (resolver) {
          delete _pendingQipuResolvers[key];
          resolver(info);
          return; // 吞掉事件，避免页面弹出棋谱界面
        }
      }
      return orig.apply(this, arguments);
    };
    _dispatchHookInstalled = true;
    return true;
  }

  function fetchQipuData(qipuModel, qipuId) {
    return new Promise(function(resolve, reject) {
      if (!installDispatchHook(qipuModel)) {
        reject(new Error('找不到详情回调方法（天天象棋前端可能升级了，请检查 DEBUGGING.md）'));
        return;
      }

      var key = String(qipuId);
      var timeoutId = setTimeout(function() {
        delete _pendingQipuResolvers[key];
        reject(new Error('Timeout fetching qipu ' + qipuId));
      }, 15000);

      _pendingQipuResolvers[key] = function(collectData) {
        clearTimeout(timeoutId);
        resolve(collectData);
      };

      // 注意：新版 requestGetQipuInfo 命中页面本地棋谱缓存时会同步走 khb→分发方法，
      // 所以必须先注册 resolver 再发请求。
      qipuModel.requestGetQipuInfo(String(qipuId), -1, false, 99, false, false);
    });
  }

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }


  // 请求方法名和列表数组名在不同 bundle 版本里会变（历史: Sj→Xj→Yj→fk→Bj; Beb→Wfb→qgb→skb/tkb），
  // 全部运行时识别并缓存。
  var _listArrayName = null;
  var _fetchMethodName = null;

  // 识别策略: 原型链上签名匹配 TRequestGetDataList + requestData(85131, ...) 的方法
  function detectFetchMethod(qipuModel) {
    try {
      var funcs = collectFunctionNames(qipuModel);
      for (var i = 0; i < funcs.length; i++) {
        var k = funcs[i];
        try {
          var s = qipuModel[k].toString();
          if (s.indexOf('TRequestGetDataList') !== -1 && s.indexOf('85131') !== -1) {
            return k;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  // 识别策略: 取首项含 qipuId + createTime 双字段、长度最大的数组，排除 _underscored 命名字段
  function detectListArrayName(qipuModel) {
    var keys = Object.keys(qipuModel);
    var best = null;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.charAt(0) === '_') continue;
      var arr = qipuModel[k];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      var item = arr[0];
      if (!item || typeof item.qipuId === 'undefined') continue;
      if (typeof item.createTime === 'undefined') continue;
      if (!best || arr.length > qipuModel[best].length) best = k;
    }
    return best;
  }

  function fetchPage(qipuModel, pageNum) {
    return new Promise(function(resolve, reject) {
      if (!_fetchMethodName || typeof qipuModel[_fetchMethodName] !== 'function') {
        _fetchMethodName = detectFetchMethod(qipuModel);
      }
      if (!_fetchMethodName) {
        reject(new Error('找不到对局列表请求方法（天天象棋前端可能升级了，请检查 DEBUGGING.md）'));
        return;
      }

      if (!_listArrayName || !Array.isArray(qipuModel[_listArrayName])) {
        _listArrayName = detectListArrayName(qipuModel);
      }
      if (_listArrayName) {
        qipuModel[_listArrayName] = [];
      }

      try {
        qipuModel[_fetchMethodName](13, pageNum, PAGE_SIZE, 0);
      } catch (e) {
        reject(new Error('请求方法 ' + _fetchMethodName + ' 调用失败: ' + e.message));
        return;
      }

      setTimeout(function() {
        // 如果缓存的数组名失效或为空，重新检测一次
        if (!_listArrayName || !Array.isArray(qipuModel[_listArrayName]) || qipuModel[_listArrayName].length === 0) {
          var refreshed = detectListArrayName(qipuModel);
          if (refreshed) _listArrayName = refreshed;
        }
        var arr = _listArrayName ? qipuModel[_listArrayName] : null;
        resolve(Array.isArray(arr) ? arr.slice() : []);
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
      }).catch(function(err) {
        sendError(err && err.message ? err.message : '加载对局列表失败');
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
        sendDone({ count: finalResults.length, cached: cached, fetched: fetched, failed: failed, pgn: pgn, filename: filename });
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

  function sendGameList(games, failed) {
    window.postMessage({ type: 'QQCHESS_GAME_LIST', payload: { games: games, failed: failed || 0 } }, '*');
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
      var failedCount = 0;
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
          }), failedCount);
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
            failedCount++;
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
    }).catch(function(err) {
      sendError(err && err.message ? err.message : '加载对局列表失败');
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
