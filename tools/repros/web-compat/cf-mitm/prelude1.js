(function(){
  var tag='__HOST__'+(window===window.top?'':'(iframe)');
  function L(){ try{ console.log('CF['+tag+'] '+Array.prototype.join.call(arguments,' ')); }catch(e){} }
  L('prelude start ua='+navigator.userAgent.slice(0,30));
  var js=JSON.stringify;
  JSON.stringify=function(v){ try{ if(v instanceof Error){ L('ERR-STRINGIFY', v.name+': '+v.message+' | '+String(v.stack).split('\n').slice(0,4).join(' || ')); } }catch(e){} return js.apply(this,arguments); };
  var xs=XMLHttpRequest.prototype.send, xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){ this.__u=u; return xo.apply(this,arguments); };
  XMLHttpRequest.prototype.send=function(b){ L('XHR', this.__u&&String(this.__u).replace(/[A-Za-z0-9_.:-]{40,}/g,'…'), 'bodylen='+(b&&b.length)); return xs.apply(this,arguments); };
  window.addEventListener('error',function(e){ L('WINERR', e.message, e.filename, e.lineno, e.colno, e.error&&e.error.stack&&String(e.error.stack).split('\n').slice(0,3).join(' || ')); },true);
  window.addEventListener('unhandledrejection',function(e){ L('UNHANDLED', String(e.reason&&(e.reason.stack||e.reason))); });
  window.addEventListener('message',function(e){ L('MSG', typeof e.data==='string'?e.data.slice(0,150):js(e.data).slice(0,300)); },true);
})();
