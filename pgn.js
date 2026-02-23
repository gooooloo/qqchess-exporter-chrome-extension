(function() {
  if (window.QQChessPGN) return;

  var COLS = 'abcdefghi';
  var DRAW_TYPES = {3: true, 5: true, 6: true, 12: true, 14: true};
  var DEFAULT_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

  function movelistToICCS(movelist) {
    if (!movelist || movelist.length === 0) {
      return [];
    }
    var moves = [];
    for (var i = 0; i + 3 < movelist.length; i += 4) {
      var fromCol = parseInt(movelist[i], 10);
      var fromRow = parseInt(movelist[i + 1], 10);
      var toCol = parseInt(movelist[i + 2], 10);
      var toRow = parseInt(movelist[i + 3], 10);
      moves.push(COLS[fromCol] + fromRow + COLS[toCol] + toRow);
    }
    return moves;
  }

  function mapResult(resultType, resultStr) {
    if (resultStr === '1-0' || resultStr === '0-1' || resultStr === '1/2-1/2') {
      return resultStr;
    }
    if (DRAW_TYPES[resultType]) {
      return '1/2-1/2';
    }
    return '*';
  }

  function formatDate(timestamp) {
    var d = new Date(timestamp * 1000);
    var y = d.getFullYear();
    var m = ('0' + (d.getMonth() + 1)).slice(-2);
    var day = ('0' + d.getDate()).slice(-2);
    return y + '.' + m + '.' + day;
  }

  function formatTime(timestamp) {
    var d = new Date(timestamp * 1000);
    var h = ('0' + d.getHours()).slice(-2);
    var min = ('0' + d.getMinutes()).slice(-2);
    var s = ('0' + d.getSeconds()).slice(-2);
    return h + ':' + min + ':' + s;
  }

  function escapeHeader(val) {
    if (!val) return '';
    return String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function generatePGN(sData, metadata) {
    var userinfo = sData.userinfo || {};
    var moveinfo = sData.moveinfo || {};
    var result = mapResult(sData.resultType, sData.result);

    var event = metadata.event || '';
    var date = metadata.createTime ? formatDate(metadata.createTime) : '????.??.??';
    var time = metadata.createTime ? formatTime(metadata.createTime) : '';

    var redName = userinfo.redname || '?';
    var blackName = userinfo.blackname || '?';
    var redTeam = userinfo.redteam || '';
    var blackTeam = userinfo.blackteam || '';

    // 从 extPlayers 补充段位信息
    if (metadata.extPlayers && metadata.extPlayers.length >= 2) {
      var p = metadata.extPlayers;
      if (!redTeam && p[0] && p[0].teamName) redTeam = p[0].teamName;
      if (!blackTeam && p[1] && p[1].teamName) blackTeam = p[1].teamName;
    }

    var headers = [];
    headers.push('[Game "Chinese Chess"]');
    if (event) headers.push('[Event "' + escapeHeader(event) + '"]');
    headers.push('[Site "h5login.qqchess.qq.com"]');
    headers.push('[Date "' + date + '"]');
    if (time) headers.push('[Time "' + time + '"]');
    headers.push('[Red "' + escapeHeader(redName) + '"]');
    headers.push('[Black "' + escapeHeader(blackName) + '"]');
    if (redTeam) headers.push('[RedTeam "' + escapeHeader(redTeam) + '"]');
    if (blackTeam) headers.push('[BlackTeam "' + escapeHeader(blackTeam) + '"]');
    headers.push('[Result "' + result + '"]');
    headers.push('[FEN "' + DEFAULT_FEN + '"]');

    var moves = movelistToICCS(moveinfo.movelist);
    var moveText = '';
    for (var i = 0; i < moves.length; i += 2) {
      var num = Math.floor(i / 2) + 1;
      moveText += num + '. ' + moves[i];
      if (i + 1 < moves.length) {
        moveText += ' ' + moves[i + 1];
      }
      moveText += ' ';
    }
    moveText += ' ' + result;

    return headers.join('\n') + '\n\n' + moveText.trim() + '\n';
  }

  function generateMultiPGN(games) {
    var parts = [];
    for (var i = 0; i < games.length; i++) {
      parts.push(generatePGN(games[i].sData, games[i].metadata));
    }
    return parts.join('\n');
  }

  var exports = {
    movelistToICCS: movelistToICCS,
    mapResult: mapResult,
    generatePGN: generatePGN,
    generateMultiPGN: generateMultiPGN
  };

  if (typeof window !== 'undefined') {
    window.QQChessPGN = exports;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})();
