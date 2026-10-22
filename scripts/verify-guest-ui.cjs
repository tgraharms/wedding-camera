const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const os = require('node:os');
const { join } = require('node:path');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    let eventState='open', saved;
    const picture=(w,h,color)=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${color}"/><circle cx="${w/2}" cy="${h/3}" r="${w/5}" fill="#fff3dd"/><text x="50%" y="80%" text-anchor="middle" font-size="20" fill="white">${w} × ${h}</text></svg>`);
    // A fresh context per run so a wish saved at one width is not still in the field at the next.
    // Service workers are blocked so page.route sees every API call when PREVIEW_URL is a real deploy.
    const newPage=async width=>{
      const context=await browser.newContext({viewport:{width,height:664},serviceWorkers:'block'});
      const page=await context.newPage();
      // This gallery-layout fixture represents a returning guest with photos.
      await page.addInitScript(() => localStorage.setItem('wc.doneCount', '2'));
      await page.route('**/api/**', async route=>{
        const path=new URL(route.request().url()).pathname;
        let body={};
        if(path==='/api/status')body=eventState==='open'?{state:'open',eventId:'demo',eventName:'Demo'}:{state:eventState};
        // total must match the photo count: the gallery syncs wc.doneCount from it.
        else if(path==='/api/me/photos')body={photos:[{id:'portrait',imageUrl:picture(300,400,'#75907c'),capturedAt:'2026-09-12T00:00:00Z'},{id:'landscape',imageUrl:picture(400,300,'#99543e'),capturedAt:'2026-09-12T00:00:00Z'}],profile:{displayName:null,message:null},hasMore:false,total:2};
        else if(path==='/api/me/profile')saved=route.request().postDataJSON();
        else throw new Error('Unexpected API call: '+path);
        await route.fulfill({json:body});
      });
      return {context,page};
    };
    for(const width of [320,390,600,1024]) {
      const {context,page}=await newPage(width);
      await page.goto(process.env.PREVIEW_URL||'http://127.0.0.1:5173');
      const capture=page.getByRole('button',{name:'Muat Naik Lagi'});await capture.waitFor();assert.equal(await page.getByRole('button',{name:/Ambil Gambar/}).count(),0,'camera button still present');
      await page.evaluate(()=>document.fonts.ready);
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
      assert.equal(overflow,false,'page overflow at '+width);
      for(const button of await page.locator('.actions button').all()) {
        assert.equal(await button.evaluate(b=>{const a=b.getBoundingClientRect(),t=b.querySelector('span').getBoundingClientRect();return t.left>=a.left&&t.right<=a.right&&b.scrollWidth<=b.clientWidth}),true,'button clips at '+width);
      }
      if(width>=375&&width<=600)assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),true,'unnecessary vertical scroll at '+width);
      if(width===390)await page.screenshot({path:join(os.tmpdir(),'album-hero.png'),fullPage:true});
      await page.getByRole('button',{name:'Galeri Saya'}).click();
      await page.locator('.grid img').first().waitFor();
      // Grid images are lazy-loaded; natural sizes are 0 until each one finishes.
      await page.waitForFunction(()=>[...document.querySelectorAll('.grid img')].every(i=>i.complete&&i.naturalWidth>0));
      const proportions=await page.locator('.grid img').evaluateAll(imgs=>imgs.map(i=>{const s=getComputedStyle(i);return{ratio:(i.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight))/(i.clientHeight-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom)),natural:i.naturalWidth/i.naturalHeight}}));
      proportions.forEach(p=>assert.ok(Math.abs(p.ratio-p.natural)<.025,JSON.stringify(p)));
      const message=page.getByLabel('Pesanan untuk pengantin');const long='Semoga bahagia selalu bersama keluarga dan sahabat. '.repeat(10).slice(0,500);
      await message.fill(long);const savedResponse=page.waitForResponse(r=>r.url().includes('/api/me/profile'));await message.blur();await savedResponse;
      assert.equal(await message.evaluate(e=>e.scrollHeight<=e.clientHeight+2),true,'wish clipped');
      assert.equal(saved.message,long);
      if(width===390)await page.screenshot({path:join(os.tmpdir(),'album-gallery.png'),fullPage:true});
      await page.getByRole('button',{name:'Kembali'}).click();await capture.waitFor();
      console.log(width,'PASS: buttons, full portrait/landscape, 500-character wish, navigation');
      await context.close();
    }
    eventState='ended';const {page}=await newPage(390);await page.goto(process.env.PREVIEW_URL||'http://127.0.0.1:5173');await page.getByText('Muat naik telah ditutup. Terima kasih! ❤️').waitFor();assert.equal(await page.getByRole('button',{name:/Muat Naik/}).count(),0);await page.getByRole('button',{name:'Galeri Saya'}).waitFor();console.log('Ended state PASS');
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
