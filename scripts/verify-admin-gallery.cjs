const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#75907c"/><circle cx="300" cy="260" r="140" fill="#fff3dd"/></svg>');
const all = Array.from({length:181},(_,i)=>({id:`p${i}`,guestId:`g${Math.floor(i/15)}`,guestName:`Tetamu ${Math.floor(i/15)}`,message:'Semoga bahagia ❤️',eventId:i%2?'e1':'e2',eventName:i%2?'Akad':'Resepsi',imageUrl:svg,starred:false,capturedAt:'2026-10-01T12:00:00Z'}));
(async()=>{
 let verifiedBrowsers = 0;
 for(const [name,engine] of [['Chrome',chromium],['WebKit',webkit]]) {
  let browser;
  try { browser = await engine.launch(name==='Chrome'?{channel:'chrome',headless:true}:{headless:true}); }
  catch(e) { console.log(name+' unavailable: '+e.message.split('\n')[0]); continue; }
  try {
   const context = await browser.newContext({acceptDownloads:true,serviceWorkers:'block'});
   const page = await context.newPage();
   let photoRequests=0;
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/api/admin/**',async route=>{
    const url=new URL(route.request().url());let body;
    if(url.pathname.endsWith('/events'))body={events:[{id:'e1',name:'Akad',count:90,windowStart:null,windowEnd:null},{id:'e2',name:'Resepsi',count:91,windowStart:null,windowEnd:null}]};
    else if(url.pathname.endsWith('/photos')){
      photoRequests++;
      const filtered=all.filter(p=>url.searchParams.get('eventId')==='all'||p.eventId===url.searchParams.get('eventId'));
      if(url.searchParams.get('group')==='guest')filtered.sort((a,b)=>a.guestId.localeCompare(b.guestId));
      const p=Number(url.searchParams.get('page'));
      body={photos:filtered.slice(p*60,(p+1)*60),hasMore:(p+1)*60<filtered.length,counts:[{eventId:'e1',name:'Akad',count:90},{eventId:'e2',name:'Resepsi',count:91}]};
    } else if(url.pathname.endsWith('/wishes'))body={wishes:[{guestId:'g0',guestName:'Tetamu 0',message:'Semoga bahagia ❤️'},{guestId:'g1',guestName:null,message:'Tahniah!'}],hasMore:false};
    else if(url.pathname.endsWith('/star'))body={ok:true};
    else throw Error('Unexpected route '+url.pathname);
    await route.fulfill({json:body});
   });
   for(const width of [390,1280]) {
    await page.setViewportSize({width,height:800});
    await page.goto((process.env.PREVIEW_URL || 'http://127.0.0.1:5173') + '/admin');
    await page.getByRole('button',{name:'Gambar',exact:true}).click();
    await page.getByText('1–60 daripada 181 gambar',{exact:true}).waitFor();
    assert.equal(await page.locator('.admin-photo-card').count(),60);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow');
    const initialRequests=photoRequests;
    await page.getByRole('button',{name:'Halaman 2',exact:true}).first().click();
    await page.getByText('61–120 daripada 181 gambar',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Halaman 1',exact:true}).first().click();
    await page.getByText('1–60 daripada 181 gambar',{exact:true}).waitFor();
    assert.equal(photoRequests,initialRequests+1,'visited page refetched');
    await page.getByRole('button',{name:'Halaman 4',exact:true}).first().click();
    await page.getByText('181–181 daripada 181 gambar',{exact:true}).waitFor();
    assert.equal(await page.locator('.admin-photo-card').count(),1);
    await page.getByRole('button',{name:'Ucapan',exact:true}).click();
    await page.getByText('2 ucapan',{exact:true}).waitFor();
    await page.getByLabel('Cari nama atau ucapan').fill('Tahniah');
    assert.equal(await page.locator('.admin-wish').count(),1);
    const downloadEvent=page.waitForEvent('download');
    await page.getByRole('button',{name:'Simpan semua ucapan (.txt)',exact:true}).click();
    const download=await downloadEvent;
    const contents=await fs.readFile(await download.path(),'utf8');
    assert.ok(contents.includes('Semoga bahagia ❤️')&&contents.includes('Tahniah!'),'export did not include all wishes');
    await page.getByRole('button',{name:'Gambar',exact:true}).click();
    await page.getByText('181–181 daripada 181 gambar',{exact:true}).waitFor();
    await page.getByLabel('Kumpul mengikut tetamu').click();
    await page.getByText('1–60 daripada 181 gambar',{exact:true}).waitFor();
    assert.ok(await page.locator('.admin-group-title').count()>1,'no guest groups');
    await page.getByRole('button',{name:/Buka gambar/}).first().click();
    const dialog=page.getByRole('dialog');await dialog.waitFor();
    await dialog.locator('img').click();assert.equal(await dialog.isVisible(),true);
    await page.mouse.click(3,3);await dialog.waitFor({state:'hidden'});
    await page.getByRole('button',{name:/Buka gambar/}).first().click();
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    for(const layout of ['Grid','Padat','Senarai']){
      await page.getByRole('button',{name:layout,exact:true}).click();
      await page.locator('.admin-photo-card').last().scrollIntoViewIfNeeded();
      const metadata=page.locator('.admin-photo-meta').last();
      assert.ok(await metadata.isVisible(),'last row cut off in '+layout);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'layout overflow '+layout);
    }
    if(width===1280){await page.getByRole('button',{name:'Grid',exact:true}).click();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/private/tmp/admin-gallery-'+name+'.png',fullPage:false});}
    console.log(name+' '+width+' PASS: counts, cached numbered pages, grouping, backdrop, Escape, complete wishes export, all layouts');
   }
   assert.deepEqual(errors,[]);
   verifiedBrowsers++;
  } finally {await browser.close();}
 }
 assert.ok(verifiedBrowsers > 0, 'No browser was available for verification');
})().catch(e=>{console.error(e);process.exitCode=1});
