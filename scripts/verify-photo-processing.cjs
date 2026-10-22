// Local browser regression check. Requires Playwright and a running Vite server.
// NODE_PATH may point to the desktop app's bundled Node packages.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5173');
    const results = await page.evaluate(async (legacy) => {
      const { processImage } = await import('/src/lib/imageProcessor.ts');
      const source = document.createElement('canvas'); source.width = 80; source.height = 60;
      const ctx = source.getContext('2d');
      for (const [color,x,y] of [['#ff0000',0,0],['#00ff00',40,0],['#0000ff',0,30],['#ffff00',40,30]]) {
        ctx.fillStyle = color; ctx.fillRect(x,y,40,30);
      }
      const raw = new Uint8Array(await (await new Promise(r => source.toBlob(r,'image/jpeg',1))).arrayBuffer());
      const expected = ['RGBY','GRYB','YBGR','BYRG','RBGY','BRYG','YGBR','GYRB'];
      const colors = { R:[255,0,0], G:[0,255,0], B:[0,0,255], Y:[255,255,0] };
      const rows = [];
      for (let orientation=1;orientation<=8;orientation++) {
        const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,77,77,0,42,0,0,0,8,0,1,1,18,0,3,0,0,0,1,0,orientation,0,0,0,0,0,0]);
        const input = new Blob([raw.slice(0,2),exif,raw.slice(2)],{type:'image/jpeg'});
        const output = legacy ? await processImage(input,'12 Sep 2026, 1:00 AM',{maxDimension:1600}) : await processImage(input,{maxDimension:1600});
        const bitmap = await createImageBitmap(output);
        const out = document.createElement('canvas');out.width=bitmap.width;out.height=bitmap.height;
        const draw = out.getContext('2d');draw.drawImage(bitmap,0,0);bitmap.close();
        const wantSize=orientation>=5?[60,80]:[80,60];
        let maxError=0;
        // Sample safely inside each corner, including the lower stamp area.
        const points=[[.2,.2],[.8,.2],[.2,.85],[.8,.85]];
        points.forEach(([x,y],i)=>{const pixel=draw.getImageData(Math.floor(x*out.width),Math.floor(y*out.height),1,1).data;const want=colors[expected[orientation-1][i]];want.forEach((v,c)=>maxError=Math.max(maxError,Math.abs(v-pixel[c])));});
        rows.push({orientation,width:out.width,height:out.height,maxError,pass:out.width===wantSize[0]&&out.height===wantSize[1]&&maxError<35});
      }
      return rows;
    }, process.env.LEGACY_PROCESSOR === '1');
    console.table(results);
    if (results.some(r => !r.pass)) throw new Error('Orientation or unstamped pixel regression');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
