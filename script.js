const canvas = document.getElementById("spectrogram");
const ctx = canvas.getContext("2d");
const colorbar = document.getElementById("colorbar");
const cctx = colorbar.getContext("2d");
const dateSelect = document.getElementById("dateSelect");
const rangeSelect = document.getElementById("rangeSelect");
const scaleSelect = document.getElementById("scaleSelect");
const statusText = document.getElementById("statusText");
const plotTitle = document.getElementById("plotTitle");
const plotMeta = document.getElementById("plotMeta");
const dataMessage = document.getElementById("dataMessage");

let dataset = null;

function resizeCanvas(c) {
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(r.width*dpr));
  c.height = Math.max(1, Math.round(r.height*dpr));
  return dpr;
}

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function percentile(a,p){
  const x=[...a].sort((m,n)=>m-n), i=(x.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i);
  return lo===hi?x[lo]:x[lo]+(x[hi]-x[lo])*(i-lo);
}
function colour(t){
  // dark blue -> cyan -> yellow -> orange -> red
  t=clamp(t,0,1);
  const stops=[[0,[3,8,28]],[.2,[8,45,105]],[.45,[20,150,190]],[.68,[220,225,80]],[.84,[255,135,35]],[1,[210,28,32]]];
  for(let i=1;i<stops.length;i++){
    if(t<=stops[i][0]){
      const [p,a]=stops[i-1], [q,b]=stops[i], u=(t-p)/(q-p);
      return `rgb(${Math.round(a[0]+u*(b[0]-a[0]))},${Math.round(a[1]+u*(b[1]-a[1]))},${Math.round(a[2]+u*(b[2]-a[2]))})`;
    }
  }
  return "rgb(210,28,32)";
}
function log10(x){return Math.log(x)/Math.LN10;}

function draw(){
  if(!dataset) return;
  const dpr=resizeCanvas(canvas);
  const W=canvas.width,H=canvas.height;
  const cols=dataset.values.length, rows=dataset.freq_khz.length;
  const all=dataset.values.flat().filter(Number.isFinite);
  let lo=scaleSelect.value==="percentile"?percentile(all,.10):Math.min(...all);
  let hi=scaleSelect.value==="percentile"?percentile(all,.90):Math.max(...all);
  if(hi<=lo) hi=lo+1;

  ctx.clearRect(0,0,W,H);
  const img=ctx.createImageData(W,H);
  const yMin=dataset.freq_khz[0], yMax=dataset.freq_khz[rows-1];
  const [fLo,fHi]=rangeSelect.value.split("-").map(Number);

  for(let y=0;y<H;y++){
    const frac=y/(H-1);
    const f=fHi*Math.pow(fLo/fHi,frac);
    let rf=(log10(f)-log10(yMin))/(log10(yMax)-log10(yMin));
    rf=clamp(rf,0,1);
    const rpos=(1-rf)*(rows-1);
    const r0=Math.floor(rpos), r1=Math.min(rows-1,r0+1), u=rpos-r0;
    for(let x=0;x<W;x++){
      const cpos=(x/(W-1))*(cols-1), c0=Math.floor(cpos), c1=Math.min(cols-1,c0+1), v=cpos-c0;
      const z=(1-v)*((1-u)*dataset.values[c0][r0]+u*dataset.values[c0][r1])
             +v*((1-u)*dataset.values[c1][r0]+u*dataset.values[c1][r1]);
      const t=clamp((z-lo)/(hi-lo),0,1);
      const s=colour(t).match(/\d+/g).map(Number), k=(y*W+x)*4;
      img.data[k]=s[0]; img.data[k+1]=s[1]; img.data[k+2]=s[2]; img.data[k+3]=255;
    }
  }
  ctx.putImageData(img,0,0);

  // AKR reference bands used in the user's original figure
  ctx.save(); ctx.setLineDash([7,6]); ctx.strokeStyle="rgba(255,255,255,.72)"; ctx.lineWidth=1.2*dpr;
  for(const f of [25,100]){
    if(f>=fLo && f<=fHi){
      const y=(log10(fHi)-log10(f))/(log10(fHi)-log10(fLo))*H;
      ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();
    }
  }
  ctx.restore();

  drawColorbar(lo,hi);
  document.getElementById("cbMax").textContent=hi.toFixed(2);
  document.getElementById("cbMid").textContent=((hi+lo)/2).toFixed(2);
  document.getElementById("cbMin").textContent=lo.toFixed(2);
}

function drawColorbar(){
  resizeCanvas(colorbar);
  const W=colorbar.width,H=colorbar.height;
  const img=cctx.createImageData(W,H);
  for(let y=0;y<H;y++){
    const t=1-y/(H-1), s=colour(t).match(/\d+/g).map(Number);
    for(let x=0;x<W;x++){const k=(y*W+x)*4;img.data[k]=s[0];img.data[k+1]=s[1];img.data[k+2]=s[2];img.data[k+3]=255;}
  }
  cctx.putImageData(img,0,0);
}

function makeDemo(){
  const freq=Array.from({length:180},(_,i)=>10*Math.pow(1500,i/179));
  const values=Array.from({length:288},(_,t)=>{
    const centre=120+80*Math.sin(t/38)+18*Math.sin(t/9);
    return freq.map((f,j)=>{
      const base=-5.2+0.35*Math.sin(j/17);
      const akr=3.8*Math.exp(-Math.pow((log10(f)-log10(centre))/0.22,2));
      const band=1.8*Math.exp(-Math.pow((log10(f)-log10(280))/0.13,2))*(0.4+0.6*Math.sin(t/12)**2);
      const burst=(t>95&&t<145)?2.5*Math.exp(-Math.pow((log10(f)-log10(180))/0.18,2)):0;
      return base+akr*(0.35+0.65*Math.sin(t/18)**2)+band+burst+(Math.random()-.5)*.35;
    });
  });
  return {date:"Demo",freq_khz:freq,values};
}

async function loadData(){
  statusText.textContent="Loading…";
  try{
    if(dateSelect.value==="demo"){ dataset=makeDemo(); statusText.textContent="Demo data"; }
    else{
      const r=await fetch("data/akr.json?ts="+Date.now(),{cache:"no-store"});
      if(!r.ok) throw new Error("data/akr.json not available");
      dataset=await r.json(); statusText.textContent="CDAWeb-derived data";
    }
    plotTitle.textContent=`AKR electric-field spectrum — ${dataset.date}`;
    plotMeta.textContent=`${dataset.values.length} time samples • ${dataset.freq_khz.length} frequency bins • logarithmic frequency axis`;
    dataMessage.textContent = dateSelect.value==="demo"
      ? "Demo mode is active. Select 2017-11-10 after adding the generated data/akr.json product."
      : "Loaded data/akr.json from the repository.";
    draw();
  }catch(e){
    statusText.textContent="Data unavailable";
    dataMessage.textContent=e.message;
  }
}
dateSelect.addEventListener("change",loadData);
rangeSelect.addEventListener("change",draw);
scaleSelect.addEventListener("change",draw);
document.getElementById("reloadBtn").addEventListener("click",loadData);
window.addEventListener("resize",draw);
loadData();
