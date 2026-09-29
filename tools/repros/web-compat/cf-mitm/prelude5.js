(function(){
  if (window.__t5) return; window.__t5 = 1;
  var tag = '__HOST__' + (window === window.top ? '' : '(iframe)');
  function L(s){ try{ console.log('D5['+tag+'] '+s); }catch(e){} }
  var iah = Element.prototype.insertAdjacentHTML, n = 0;
  Element.prototype.insertAdjacentHTML = function(pos, html){
    var r = iah.apply(this, arguments);
    if (n++ < 3) {
      try {
        L('IAH this=<'+this.localName+'> connected='+this.isConnected+' parent='+(this.parentNode&&this.parentNode.nodeName)+' children='+this.children.length+' inner='+String(this.innerHTML).slice(0,120)+' | doc.body.children='+document.body.children.length+' | body.html='+String(document.body.innerHTML).slice(0,300).replace(/\s+/g,' ')+' | qsa(#crERV20)='+document.querySelectorAll('#crERV20').length+' | gebi='+!!document.getElementById('crERV20') + ' | root='+(this.getRootNode&&this.getRootNode().nodeName));
      } catch(e){ L('IAH err '+e.message); }
    }
    return r;
  };
  var ce = Document.prototype.createElement, cn = 0;
  Document.prototype.createElement = function(t){ var r = ce.apply(this, arguments); if (String(t)==='null' && cn++<1) L('createElement(null) => '+r.tagName+' ns='+r.namespaceURI+' proto='+Object.prototype.toString.call(r)+' body='+ (document.body&&document.body.nodeName)+' doc.readyState='+document.readyState); return r; };
  var ac = Node.prototype.appendChild, an = 0;
  Node.prototype.appendChild = function(c){ var r = ac.apply(this, arguments); if (c && c.localName==='null' && an++<1) { var b=document.body; L('appendChild(<null>) into <'+this.localName+'> this===document.body:'+(this===b)+' this.ownerDoc===document:'+(this.ownerDocument===document)+' this.root='+this.getRootNode().nodeName+' this.parent='+(this.parentNode&&this.parentNode.nodeName)+' this.lastChild===c:'+(this.lastChild===c)+' this.childNodes='+this.childNodes.length+' c.connected='+c.isConnected+' c.parent='+(c.parentNode&&c.parentNode.nodeName)+' c.parent===this:'+(c.parentNode===this)+' c.ownerDoc===document:'+(c.ownerDocument===document)+' document.body.lastChild===c:'+(b.lastChild===c)+' | body children: '+Array.prototype.map.call(b.childNodes,function(x){return x.nodeName}).join(',')+' | html children: '+Array.prototype.map.call(document.documentElement.childNodes,function(x){return x.nodeName}).join(',')); } return r; };
  L('d5 installed; body='+(document.body&&document.body.nodeName)+' html='+document.documentElement.outerHTML.length);
})();
