// Chromium via Playwright, no proxy. usage: node chr.js URL [--headers] [--eval=JS] [--console] [--settle=ms]
const { chromium } = require('playwright');
const args=process.argv.slice(2);
const url=args.find(a=>!a.startsWith('--'));
const opt=(n,d)=>{const a=args.find(x=>x.startsWith(`--${n}=`));return a?a.slice(n.length+3):d};
const all=(n)=>args.filter(x=>x.startsWith(`--${n}=`)).map(x=>x.slice(n.length+3));
(async()=>{
  const b=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});
  const ctx=await b.newContext({locale:'de-DE',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'});
  const p=await ctx.newPage();
  if(args.includes('--console')){p.on('console',m=>console.error('console.'+m.type()+': '+m.text()));p.on('pageerror',e=>console.error('console.error: Uncaught '+e.message));}
  await p.goto(url,{waitUntil:'load',timeout:30000}).catch(e=>console.error('nav '+e.message.split('\n')[0]));
  await p.waitForTimeout(parseInt(opt('settle','800'),10));
  for(const src of all('eval')){try{console.log(JSON.stringify(await p.evaluate(`(async()=>(${src}))()`)))}catch(e){console.log('Error: '+e.message.split('\n')[0])}}
  await b.close();
})();
