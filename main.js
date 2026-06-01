// =====================================================
// 定数
// =====================================================
const LANES = 8; // 0=SCRATCH, 1-7=keys
// KEY_TYPE[i] (i=0..7): null=scratch, true=white, false=black
const KEY_TYPE = [null, false, true, false, true, false, true, false];
// textage.cc base64 文字列
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LANE_WIDTH_RATIO = [2,1.2,1,1.2,1,1.2,1,1.2];
const CHART_DATA_DIR = './charts';
const DEFAULT_CHART_DATA_FILE = './chartData.json';
const CHART_INDEX_FILE = './chartIndex.json';
const API_BASE = '/api/getChart?url=';
const API_REFERER = 'https://www.iidx-memo.com/';

// =====================================================
// 状態
// =====================================================
let stream = null;
let analyzeRunning = false;
let rafId = null;
let playSide = '1P';

// ROI: 映像ピクセル座標 (null or {x,y,w,h})
let roi = null;
let dragging = false;
let dragStart = {x:0,y:0};

// 検出パラメータ
let params = { threshold:90, decay:10, minHits:40 };

// 各表示レーン (0=SCRATCH,1-7) の統計
let hitCount   = new Array(LANES).fill(0); // 累積ヒット数
let brightness = new Array(LANES).fill(0); // 直近輝度
let decayTimer = new Array(LANES).fill(0); // アクティブ減衰

// マッピング結果: mappedOrig[dispLane] = origLane(0-7) or null
let mappedOrig = new Array(LANES).fill(null);

function displayLaneToChartLane(displayLane) {
  if(playSide === '2P') {
    return displayLane === LANES - 1 ? 0 : displayLane + 1;
  }
  return displayLane;
}

function chartLaneToDisplayLane(chartLane) {
  if(playSide === '2P') {
    return chartLane === 0 ? LANES - 1 : chartLane - 1;
  }
  return chartLane;
}

function displayLaneLabel(displayLane) {
  if(playSide === '2P') {
    return displayLane === LANES - 1 ? 'S' : String(displayLane + 1);
  }
  return displayLane === 0 ? 'S' : String(displayLane);
}

function chartLaneLabel(chartLane) {
  return chartLane === 0 ? 'S' : String(chartLane);
}

function getLaneMetrics(totalWidth) {
  const totalRatio = LANE_WIDTH_RATIO.reduce((sum, r) => sum + r, 0);
  const widths = LANE_WIDTH_RATIO.map(r => totalWidth * r / totalRatio);
  const offsets = [0];
  for(let i=1;i<widths.length;i++){
    offsets.push(offsets[i-1] + widths[i-1]);
  }
  return { widths, offsets };
}

function getLaneColor(chartLane) {
  if(chartLane === 0) return 'rgba(255,68,85,0.85)';
  return chartLane % 2 === 1 ? 'rgba(255,255,255,0.85)' : 'rgba(68,136,255,0.85)';
}

// 正規譜面データ (textageから取得)
let chartData = null; // { title, artist, bpm, notes:[[laneIdx(0-6), position],...] }
let chartIndex = null;
let chartIndexDisplay = [];
let selectedChart = null;

// =====================================================
// DOM
// =====================================================
const video      = document.getElementById('srcVideo');
const overCanvas = document.getElementById('overlayCanvas');
const roiCanvas  = document.getElementById('roiCanvas');
const octx       = overCanvas.getContext('2d');
const rctx       = roiCanvas.getContext('2d');
const refCanvas  = document.getElementById('chartRefCanvas');
const rfctx      = refCanvas.getContext('2d');
const noSource   = document.getElementById('noSource');
const footerContainer = document.getElementById('footerContainer');
const footerResizer = document.getElementById('footerResizer');
const offscreenCanvas = document.createElement('canvas');
const offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

// =====================================================
// ログ
// =====================================================
function log(msg, cls='') {
  const box = document.getElementById('logBox');
  const d = document.createElement('div');
  if(cls) d.className = cls;
  const t = new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  d.textContent = `[${t}] ${msg}`;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  while(box.children.length > 80) box.firstChild.remove();
}

// =====================================================
// ステータス
// =====================================================
function setStatus(label, state='') {
  document.getElementById('statusLabel').textContent = label;
  document.getElementById('statusDot').className = 'status-dot' + (state?' '+state:'');
}

// =====================================================
// 映像ソース
// =====================================================
async function startSource(type) {
  try {
    if(stream) stopSource();
    if(type === 'screen') {
      stream = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:60,cursor:'never'},audio:false});
    } else {
      stream = await navigator.mediaDevices.getUserMedia({video:{width:1920,height:1080,frameRate:60},audio:false});
    }
    video.srcObject = stream;
    await video.play();
    noSource.style.display = 'none';
    document.getElementById('btnStop').style.display = '';
    document.getElementById('btnScreen').classList.toggle('on', type==='screen');
    document.getElementById('btnCamera').classList.toggle('on', type==='camera');
    document.getElementById('btnAnalyze').disabled = false;
    setStatus('LIVE', 'live');
    stream.getVideoTracks()[0].onended = () => stopSource();
    video.addEventListener('loadedmetadata', () => {
      const w=video.videoWidth, h=video.videoHeight;
      overCanvas.width = roiCanvas.width = w;
      overCanvas.height = roiCanvas.height = h;
      log(`映像: ${w}×${h}`, 'log-info');
    }, {once:true});
    log(`${type==='screen'?'画面':'カメラ'}キャプチャ開始`, 'log-ok');
  } catch(e) {
    log('映像取得失敗: '+e.message, 'log-err');
  }
}

function stopSource() {
  stream?.getTracks().forEach(t=>t.stop());
  stream = null;
  video.srcObject = null;
  noSource.style.display = '';
  document.getElementById('btnStop').style.display = 'none';
  document.getElementById('btnScreen').classList.remove('on');
  document.getElementById('btnCamera').classList.remove('on');
  document.getElementById('btnAnalyze').disabled = true;
  stopAnalysis();
  setStatus('STANDBY');
  log('映像停止');
}

// =====================================================
// ROI ドラッグ
// =====================================================
function getCanvasPos(e) {
  const r = roiCanvas.getBoundingClientRect();
  const sx = roiCanvas.width / r.width;
  const sy = roiCanvas.height / r.height;
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const cy = e.touches ? e.touches[0].clientY : e.clientY;
  return { x:(cx-r.left)*sx, y:(cy-r.top)*sy };
}

roiCanvas.addEventListener('mousedown', e => { if(!stream) return; dragging=true; dragStart=getCanvasPos(e); });
roiCanvas.addEventListener('mousemove', e => {
  if(!dragging) return;
  const p=getCanvasPos(e);
  roi = {x:Math.min(dragStart.x,p.x), y:Math.min(dragStart.y,p.y), w:Math.abs(p.x-dragStart.x), h:Math.abs(p.y-dragStart.y)};
  drawROI();
});
roiCanvas.addEventListener('mouseup', e => {
  dragging=false;
  if(roi?.w>10 && roi?.h>10) {
    document.getElementById('roiHintText').innerHTML = `ROI設定済: ${Math.round(roi.w)}×${Math.round(roi.h)}px<br>解析を開始してください`;
    log(`ROI: x=${Math.round(roi.x)} y=${Math.round(roi.y)} w=${Math.round(roi.w)} h=${Math.round(roi.h)}`, 'log-ok');
  }
});
roiCanvas.addEventListener('touchstart', e=>{e.preventDefault();dragging=true;dragStart=getCanvasPos(e);},{passive:false});
roiCanvas.addEventListener('touchmove', e=>{e.preventDefault();const p=getCanvasPos(e);roi={x:Math.min(dragStart.x,p.x),y:Math.min(dragStart.y,p.y),w:Math.abs(p.x-dragStart.x),h:Math.abs(p.y-dragStart.y)};drawROI();},{passive:false});
roiCanvas.addEventListener('touchend', e=>{dragging=false;},{passive:false});

function drawROI() {
  rctx.clearRect(0,0,roiCanvas.width,roiCanvas.height);
  if(!roi||roi.w<2||roi.h<2) return;
  // ROI外を暗く
  rctx.fillStyle='rgba(0,0,0,0.5)';
  rctx.fillRect(0,0,roiCanvas.width,roiCanvas.height);
  rctx.clearRect(roi.x,roi.y,roi.w,roi.h);
  // 枠
  rctx.strokeStyle='#00d4ff';
  rctx.lineWidth=1.5;
  rctx.strokeRect(roi.x,roi.y,roi.w,roi.h);
  // レーン分割
  rctx.strokeStyle='rgba(0,212,255,0.3)';
  rctx.lineWidth=0.5;
  rctx.setLineDash([3,3]);
  const metrics = getLaneMetrics(roi.w);
  for(let i=1;i<LANES;i++){
    const lx = roi.x + metrics.offsets[i];
    rctx.beginPath(); rctx.moveTo(lx,roi.y); rctx.lineTo(lx,roi.y+roi.h); rctx.stroke();
  }
  rctx.setLineDash([]);
  // レーン番号
  rctx.fillStyle='#00d4ff';
  rctx.font='10px "Share Tech Mono"';
  for(let i=0;i<LANES;i++){
    const lx = roi.x + metrics.offsets[i] + metrics.widths[i] * 0.5;
    rctx.fillText(displayLaneLabel(i), lx-8, roi.y-5);
  }
}

function clearROI() {
  roi=null;
  rctx.clearRect(0,0,roiCanvas.width,roiCanvas.height);
  document.getElementById('roiHintText').innerHTML='映像上をドラッグして判定ライン付近の<br>8鍵(SCRATCH含む)エリアを囲んでください';
  log('ROIクリア');
}

// =====================================================
// 解析
// =====================================================
function toggleAnalysis() {
  if(analyzeRunning) stopAnalysis();
  else startAnalysis();
}

function startAnalysis() {
  if(!stream){log('映像ソースを選択してください','log-warn');return;}
  if(!roi){log('ROIを設定してください','log-warn');return;}
  analyzeRunning=true;
  hitCount.fill(0); brightness.fill(0); decayTimer.fill(0); mappedOrig.fill(null);
  document.getElementById('btnAnalyze').textContent='■ 解析停止';
  setStatus('DETECTING','detect');
  log('解析開始','log-ok');
  loop();
}

function stopAnalysis() {
  analyzeRunning=false;
  if(rafId){cancelAnimationFrame(rafId);rafId=null;}
  document.getElementById('btnAnalyze').textContent='● 解析開始';
  if(stream) setStatus('LIVE','live');
  log('解析停止');
}

function loop() {
  if(!analyzeRunning) return;
  processFrame();
  rafId=requestAnimationFrame(loop);
}

// =====================================================
// フレーム処理 (輝度検出)
// =====================================================
function processFrame() {
  if(!roi||video.readyState<2) return;
  const vw=video.videoWidth, vh=video.videoHeight;
  if(!vw||!vh) return;

  // offscreen canvas でピクセル取得
  offscreenCanvas.width = vw;
  offscreenCanvas.height = vh;
  offscreenCtx.drawImage(video,0,0);

  const sampleCY = roi.y + roi.h*0.5;
  const sampleHH = Math.max(1, roi.h*0.25);
  const now = performance.now();

  const detected = [];
  const metrics = getLaneMetrics(roi.w);
  for(let l=0;l<LANES;l++){
    const chartLane = displayLaneToChartLane(l);
    const lx = roi.x + metrics.offsets[l];
    const lw = metrics.widths[l];
    const sx = Math.floor(lx + lw*0.15);
    const sw = Math.max(1, Math.floor(lw*0.7));
    const sy = Math.floor(sampleCY - sampleHH);
    const sh = Math.max(1, Math.floor(sampleHH*2));
    let img;
    try { img=ox.getImageData(sx,sy,sw,sh); } catch(e){continue;}
    const d=img.data;
    let sum=0;
    for(let p=0;p<d.length;p+=4){
      sum += 0.299*d[p] + 0.587*d[p+1] + 0.114*d[p+2];
    }
    const avg = sum / (sw*sh);
    brightness[chartLane] = avg;
    if(avg > params.threshold){
      detected.push(chartLane);
      hitCount[chartLane]++;
      decayTimer[chartLane] = params.decay;
    } else {
      if(decayTimer[chartLane]>0) decayTimer[chartLane]--;
    }
  }

  updateMapping();
  drawOverlay(detected);
  updateUI();
}

// =====================================================
// RANDOMマッピング推定
// =====================================================
function updateMapping() {
  const total = hitCount.reduce((a,b)=>a+b,0);
  const confEl = document.getElementById('confFill');
  const pctEl  = document.getElementById('confPct');

  if(!chartData?.laneFreq || total < params.minHits) {
    mappedOrig.fill(null);
    confEl.style.width='0%';
    pctEl.textContent='0%';
    return;
  }

  const ref = chartData.laneFreq;
  const refTotal = ref.reduce((a,b)=>a+b,0) || 1;
  const hitTotal = total || 1;
  const refNorm = ref.map(v=>v/refTotal);
  const hitNorm = hitCount.map(v=>v/hitTotal);
  const refSorted = [0,1,2,3,4,5,6,7].sort((a,b)=>refNorm[b]-refNorm[a]);
  const hitSorted = [0,1,2,3,4,5,6,7].sort((a,b)=>hitNorm[b]-hitNorm[a]);
  const newMap = new Array(LANES).fill(null);
  hitSorted.forEach((dispLane,i)=>{
    newMap[dispLane] = refSorted[i];
  });
  mappedOrig = newMap;

  const avgF = 1/LANES;
  const variance = hitCount.reduce((s,c)=>s + Math.pow(c/total - avgF,2),0)/LANES;
  const maxVar = Math.pow(avgF,2)*(LANES-1)/LANES;
  const dataSc = Math.min(1,total/300);
  const uniformSc = Math.max(0,1-variance/Math.max(maxVar,1e-9)*3);
  const conf = Math.min(100,Math.round((dataSc*0.55+uniformSc*0.45)*100));
  confEl.style.width=conf+'%';
  confEl.style.background=conf>70?'var(--green)':conf>40?'var(--yellow)':'var(--red)';
  pctEl.textContent=conf+'%';
  pctEl.style.color=conf>70?'var(--green)':conf>40?'var(--yellow)':'var(--red)';
}

// 正規譜面のレーン頻度と実測頻度の相関でマッピング精緻化
function refineMappingWithChart(baseMap, total) {
  if(!chartData?.laneFreq) { mappedOrig=baseMap; return; }
  const orig=[0,1,2,3,4,5,6,7];
  const disp=[0,1,2,3,4,5,6,7];
  const ref=chartData.laneFreq;
  const refTotal=ref.reduce((a,b)=>a+b,0)||1;
  const hitTotal=hitCount.reduce((a,b)=>a+b,0)||1;

  const refNorm=ref.map(v=>v/refTotal);
  const hitNorm=hitCount.map(v=>v/hitTotal);
  const refSorted=[...orig].sort((a,b)=>refNorm[b]-refNorm[a]);
  const hitSorted=[...disp].sort((a,b)=>hitNorm[b]-hitNorm[a]);
  const newMap=new Array(LANES).fill(null);
  hitSorted.forEach((dispLane,i)=>{
    newMap[dispLane] = refSorted[i];
  });
  mappedOrig = newMap;
}

// =====================================================
// オーバーレイ描画
// =====================================================
function drawOverlay(detected) {
  const w=overCanvas.width, h=overCanvas.height;
  octx.clearRect(0,0,w,h);
  if(!roi) return;

  const metrics = getLaneMetrics(roi.w);
  for(let l=0;l<LANES;l++){
    const chartLane = displayLaneToChartLane(l);
    const lx = roi.x + metrics.offsets[l];
    const lw = metrics.widths[l];
    const dr = decayTimer[chartLane]/params.decay;
    if(dr>0){
      const isActive = detected.includes(chartLane);
      octx.fillStyle = isActive ? 'rgba(0,212,255,0.35)' : `rgba(0,212,255,${dr*0.15})`;
      octx.fillRect(lx,roi.y,lw,roi.h);
    }
    octx.strokeStyle='rgba(0,212,255,0.6)';
    octx.lineWidth=1.2;
    octx.strokeRect(roi.x,roi.y,roi.w,roi.h);
  }
}

// =====================================================
// UI 更新
// =====================================================
function updateUI() {
  const container=document.getElementById('laneRows');
  container.innerHTML='';
  const total=hitCount.reduce((a,b)=>a+b,0)||1;
  for(let l=0;l<LANES;l++){
    const chartLane = displayLaneToChartLane(l);
    const orig=mappedOrig[l];
    const fillPct=Math.min(100,(brightness[chartLane]/255)*100);
    const active=decayTimer[chartLane]>0;
    const origIsWhite = orig!==null && orig > 0 && KEY_TYPE[orig];
    const matchIcon = chartData&&orig!==null ? '✓' : '';

    const row=document.createElement('div');
    row.className='lane-row';
    row.innerHTML=`
      <div class="lane-idx">${displayLaneLabel(l)}</div>
      <div class="lane-bar-wrap">
        <div class="lane-bar-fill" style="width:${fillPct}%;background:${active?'var(--accent)':'rgba(0,212,255,0.18)'}"></div>
        <div class="lane-bar-text" style="color:${active?'var(--accent)':'var(--text-dim)'}">${Math.round(brightness[chartLane])}</div>
      </div>
      <div class="lane-orig ${orig===null?'unknown':orig===0?'scratch':origIsWhite?'white':'black'}">${orig===null?'?':chartLaneLabel(orig)}</div>
      <div class="lane-match" style="color:var(--green)">${matchIcon}</div>
    `;
    container.appendChild(row);
  }
  drawRefChart();
}

// =====================================================
// 正規譜面プレビュー描画
// =====================================================
function drawRefChart() {
  const wrapper = refCanvas.parentElement;
  const wrapperWidth = wrapper ? wrapper.clientWidth : 320;
  const ch = refCanvas.parentElement?.clientHeight || 160;
  const notes = chartData?.notes || [];
  if(!notes.length){
    refCanvas.width = wrapperWidth;
    refCanvas.height = ch;
    rfctx.clearRect(0,0,refCanvas.width,refCanvas.height);
    rfctx.fillStyle='#16161f';
    rfctx.fillRect(0,0,refCanvas.width,refCanvas.height);
    rfctx.fillStyle='#3a3a55';
    rfctx.font='9px "Share Tech Mono"';
    rfctx.fillText('NO CHART DATA',8,20);
    return;
  }

  const totalRatio = LANE_WIDTH_RATIO.reduce((sum,r)=>sum+r,0);
  const targetLaneWidth = Math.max(28, wrapperWidth / 8);
  const groupWidth = totalRatio * targetLaneWidth;
  const maxPos = notes.reduce((m,n)=>Math.max(m,n[1]),0) || 1;
  const totalMeasures = Math.ceil((maxPos+1)/384);
  const groupCount = Math.max(1, Math.ceil(totalMeasures / 4));
  const groupSpacing = 12;
  const fullWidth = groupCount * groupWidth + Math.max(0, groupCount-1) * groupSpacing;
  refCanvas.width = Math.max(wrapperWidth, Math.round(fullWidth));
  refCanvas.height = ch;
  rfctx.clearRect(0,0,refCanvas.width,refCanvas.height);
  rfctx.fillStyle='#16161f';
  rfctx.fillRect(0,0,refCanvas.width,refCanvas.height);

  const metrics = getLaneMetrics(groupWidth);
  const origToDisp = new Array(LANES).fill(-1);
  mappedOrig.forEach((orig,disp)=>{ if(orig!==null) origToDisp[orig]=disp; });

  notes.forEach(([origLane, pos]) => {
    const disp = origToDisp[origLane];
    const targetLane = disp>=0 ? disp : chartLaneToDisplayLane(origLane);
    const measureIndex = Math.floor(pos / 384);
    const groupIndex = Math.floor(measureIndex / 4);
    const inGroupPos = (measureIndex % 4) * 384 + (pos % 384);
    const x = metrics.offsets[targetLane] + groupIndex * (groupWidth + groupSpacing);
    const y = ch - (inGroupPos / (384 * 4)) * ch;
    rfctx.fillStyle = getLaneColor(origLane);
    rfctx.fillRect(x+1, y, Math.max(1, metrics.widths[targetLane]-2), 3);
  });

  rfctx.strokeStyle='rgba(255,255,255,0.12)';
  rfctx.lineWidth=0.6;
  for(let i=1;i<LANES;i++){
    const x = metrics.offsets[i];
    for(let g=0;g<groupCount;g++){
      const gx = x + g * (groupWidth + groupSpacing);
      rfctx.beginPath(); rfctx.moveTo(gx,0); rfctx.lineTo(gx,ch); rfctx.stroke();
    }
  }

  rfctx.strokeStyle='rgba(255,255,255,0.18)';
  rfctx.lineWidth=0.5;
  for(let g=0;g<groupCount;g++){
    const base = g * (groupWidth + groupSpacing);
    for(let m=1;m<4;m++){
      const mx = base + m * (groupWidth / 4);
      rfctx.beginPath(); rfctx.moveTo(mx,0); rfctx.lineTo(mx,ch); rfctx.stroke();
    }
  }
}

let footerDragActive = false;
let footerStartY = 0;
let footerStartHeight = 0;

function initFooterResizer() {
  const resizer = document.getElementById('footerResizer');
  const container = document.getElementById('footerContainer');
  if(!resizer || !container) return;

  const startDrag = (clientY) => {
    footerDragActive = true;
    footerStartY = clientY;
    footerStartHeight = container.getBoundingClientRect().height;
    document.body.style.userSelect = 'none';
  };

  const doDrag = (clientY) => {
    if(!footerDragActive) return;
    const delta = footerStartY - clientY;
    const nextHeight = footerStartHeight + delta;
    const minHeight = 120;
    const maxHeight = window.innerHeight * 0.6;
    container.style.height = Math.min(maxHeight, Math.max(minHeight, nextHeight)) + 'px';
  };

  const endDrag = () => {
    if(!footerDragActive) return;
    footerDragActive = false;
    document.body.style.userSelect = '';
  };

  resizer.addEventListener('mousedown', (e) => {
    startDrag(e.clientY);
  });
  window.addEventListener('mousemove', (e) => {
    doDrag(e.clientY);
  });
  window.addEventListener('mouseup', endDrag);
  resizer.addEventListener('touchstart', (e) => {
    startDrag(e.touches[0].clientY);
    e.preventDefault();
  }, {passive:false});
  window.addEventListener('touchmove', (e) => {
    if(e.touches.length) doDrag(e.touches[0].clientY);
  }, {passive:false});
  window.addEventListener('touchend', endDrag);
}

// =====================================================
// textage.cc 譜面取得・解析
// =====================================================
function onUrlInput(val) {
  // ローカル JSON からの読み込みを前提としているため、入力チェックは不要です。
}

async function fetchChartIndex() {
  const infoBox = document.getElementById('chartInfoBox');
  const list = document.getElementById('chartIndexList');
  if(infoBox) infoBox.innerHTML = '<span style="color:var(--accent)">INDEX 読込中<span class="spinner"></span></span>';
  log('chartIndex.json を読み込み中...', 'log-info');
  try {
    const res = await fetch('./chartIndex.json');
    if(!res.ok) throw new Error(`chartIndex.json の読み込みに失敗しました (${res.status})`);
    chartIndex = await res.json();
    chartIndexDisplay = chartIndex.charts.slice(0, 100);
    renderChartIndexList(chartIndexDisplay);
    selectedChart = null;
    showSelectedChartInfo();
    if(infoBox) infoBox.innerHTML = '<span style="color:var(--green);font-size:9px">✓ INDEX 読込完了</span>';
    log('chartIndex.json 読込完了', 'log-ok');
  } catch(e) {
    log('読み込みエラー: '+e.message, 'log-err');
    if(infoBox) infoBox.innerHTML = `<span style="color:var(--red)">エラー: ${e.message}</span>`;
    chartIndex = null;
    chartIndexDisplay = [];
    list.innerHTML = '';
  }
}

function filterChartIndex(keyword) {
  if(!chartIndex?.charts) return [];
  const q = (keyword||'').trim().toLowerCase();
  if(!q) return chartIndex.charts.slice(0, 100);
  return chartIndex.charts.filter(item =>
    item.title.toLowerCase().includes(q) ||
    item.version.toLowerCase().includes(q) ||
    item.difficultyType.toLowerCase().includes(q) ||
    String(item.difficulty).includes(q)
  ).slice(0, 100);
}

function renderChartIndexList(items) {
  const list = document.getElementById('chartIndexList');
  if(!list) return;
  chartIndexDisplay = items || [];
  if(chartIndexDisplay.length === 0) {
    list.innerHTML = '<div class="chart-index-item"><span class="item-title">候補なし</span></div>';
    return;
  }
  list.innerHTML = chartIndexDisplay.map((item, index) =>
    `<div class="chart-index-item ${selectedChart===item?'active':''}" onclick="selectChartItem(${index})">
       <div class="item-title">${item.title}</div>
       <div class="item-meta">${item.version} / ${item.difficultyType} ${item.difficulty} / ${item.url}</div>
     </div>`
  ).join('');
}

function selectChartItem(index) {
  const item = chartIndexDisplay[index];
  if(!item) return;
  selectedChart = item;
  document.getElementById('textageUrl').value = item.url;
  showSelectedChartInfo();
  renderChartIndexList(chartIndexDisplay);
  log(`選択: ${item.title} [${item.difficultyType}${item.difficulty}]`, 'log-info');
  fetchChart();
}

function showSelectedChartInfo() {
  const infoBox = document.getElementById('chartInfoBox');
  if(!infoBox) return;
  if(selectedChart) {
    const expectedPath = getLocalChartDataPath(selectedChart.url);
    infoBox.innerHTML = `
      <div class="info-title">${selectedChart.title}</div>
      <div class="info-meta">${selectedChart.version} / ${selectedChart.difficultyType} ${selectedChart.difficulty}</div>
      <div class="info-meta">URL: ${selectedChart.url}</div>
      <div class="info-meta" style="color:var(--text-dim);font-size:9px">ローカルファイル: ${expectedPath}</div>
      <div style="margin-top:4px;color:var(--accent);font-size:9px">選択済み: 自動でローカル CHART JSON を読み込みます</div>
    `;
    return;
  }
  if(chartIndex) {
    infoBox.innerHTML = '<span style="color:var(--text-dim);font-size:9px">検索してチャートを選択してください。@index から選択できます。</span>';
    return;
  }
  infoBox.innerHTML = '<span style="color:var(--text-dim);font-size:9px">textage.cc URL または ./chartData.json を入力して読込ボタンを押してください</span>';
}

function sanitizeChartFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[_\.]+|[_\.]+$/g, '');
}

function getChartDataFileNameFromUrl(chartUrl) {
  try {
    const u = new URL(chartUrl, window.location.href);
    let file = u.pathname.split('/').pop() || 'chart';
    file = file.replace(/\.html$/i, '');
    const query = u.searchParams.toString();
    if(query) file += `_${query}`;
    file = sanitizeChartFileName(file);
    return `${CHART_DATA_DIR}/${file}.json`;
  } catch (e) {
    return DEFAULT_CHART_DATA_FILE;
  }
}

function getLocalChartDataPath(input) {
  const value = (input || '').trim();
  if(!value) return DEFAULT_CHART_DATA_FILE;
  if(value.toLowerCase().endsWith('.json')) return value;
  return getChartDataFileNameFromUrl(value);
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function isLocalJsonPath(value) {
  if(!value) return false;
  const v=value.trim();
  return v.toLowerCase().endsWith('.json') || v.startsWith('./') || v.startsWith('/') && !v.startsWith('//');
}

function normalizeChartNote(item) {
  if(!item) return null;
  if(Array.isArray(item)){
    const lane0 = Number(item[0]);
    const pos = Number(item[1] || 0);
    if(!Number.isFinite(lane0)) return null;
    if(lane0 >= 0 && lane0 <= 7) return [lane0, pos];
    return null;
  }
  if(typeof item==='object'){
    const laneRaw = Number(item.lane ?? item.col ?? item.key ?? item.column ?? item.origLane ?? item.orig ?? item[0] ?? 0);
    if(!Number.isFinite(laneRaw)) return null;
    const rawPos = Number(item.pos ?? item.time ?? item.timing ?? item.row ?? item.y ?? 0);
    const measureRaw = Number(item.measure ?? item.bar ?? item.measureNo ?? 0);
    let pos = Number.isFinite(rawPos) ? rawPos : 0;
    if(Number.isFinite(measureRaw)){
      const measureIndex = measureRaw > 0 ? measureRaw - 1 : measureRaw;
      pos += measureIndex * 384;
    }
    let lane = laneRaw;
    if(lane >= 1 && lane <= 7) {
      lane = laneRaw;
    }
    return [lane, pos];
  }
  return null;
}

function normalizeChartNotes(notes) {
  if(!Array.isArray(notes)) return [];
  const normalized = notes
    .map(normalizeChartNote)
    .filter(n=>n && Number.isFinite(n[0]) && n[0]>=0 && n[0]<LANES);
  const hasScratch = normalized.some(([lane]) => lane === 0);
  if(hasScratch) return normalized;
  const maxLane = normalized.reduce((m,[lane]) => Math.max(m, lane), -1);
  if(maxLane <= 6) {
    return normalized.map(([lane,pos]) => [lane + 1, pos]);
  }
  return normalized;
}

function applyApiResponse(json, rawUrl) {
  const infoBox=document.getElementById('chartInfoBox');
  const title = json.title || json.songTitle || json.name || '(UNKNOWN)';
  const artist = json.artist || json.composer || '';
  const bpm = json.bpm || json.BPM || '';
  const diffFromJson = json.difficulty || json.level || json.lv || json.diff || null;
  
  let notes=[];
  if(Array.isArray(json.notes) && json.notes.length){
    notes=normalizeChartNotes(json.notes);
  } else if(json.sp && Array.isArray(json.sp)){
    json.sp.forEach((bar,bi)=>{
      if(!Array.isArray(bar)) return;
      bar.forEach((cell,ci2)=>{
        if(!cell||cell===0) return;
        if(cell & 1) notes.push([0, bi*384 + ci2]);
        for(let l=1;l<=7;l++){
          if(cell & (1<<l)) notes.push([l, bi*384 + ci2]);
        }
      });
    });
  } else if(json.lanes && typeof json.lanes==='object'){
    Object.entries(json.lanes).forEach(([k,arr])=>{
      const lane=Number(k);
      if(lane<0||lane>7) return;
      (arr||[]).forEach(pos=>notes.push([lane, Number(pos)||0]));
    });
  } else if(Array.isArray(json.noteData) && json.noteData.length){
    notes=normalizeChartNotes(json.noteData);
  } else if(Array.isArray(json.chartData) && json.chartData.length){
    notes=normalizeChartNotes(json.chartData);
  }

  const laneFreq=new Array(LANES).fill(0);
  notes.forEach(([lane])=>{ if(lane>=0&&lane<LANES) laneFreq[lane]++; });
  const totalNotes=notes.length;

  let difficulty = diffFromJson || 'UNKNOWN';
  const m = rawUrl.match(/\?([12D])([NHAX])/i);
  if(m){
    const diffMap={N:'NORMAL',H:'HYPER',A:'ANOTHER',X:'LEGGENDARIA'};
    difficulty = diffMap[m[2].toUpperCase()]||m[2].toUpperCase();
  }

  chartData = {
    title,
    artist,
    bpm,
    difficulty,
    noteCount: totalNotes,
    laneFreq,
    notes
  };

  if(infoBox) infoBox.innerHTML = `
    <div class="info-title">${title}</div>
    <div class="info-meta">${artist} / BPM ${bpm}</div>
    <div class="info-meta">${difficulty} / ${totalNotes}notes</div>
    <div style="margin-top:4px;color:var(--green);font-size:9px">✓ API から譜面データ取得完了</div>
  `;
  log(`譜面読込(API): ${title} [${difficulty}] ${totalNotes}notes`, 'log-ok');
  drawRefChart();
}

async function fetchChart() {
  const infoBox = document.getElementById('chartInfoBox');
  const rawInput = document.getElementById('textageUrl')?.value.trim() || '';
  const rawUrl = selectedChart?.url || rawInput;
  const isUrl = isHttpUrl(rawUrl);
  const isJson = isLocalJsonPath(rawUrl);
  const localPath = rawUrl ? getLocalChartDataPath(rawUrl) : DEFAULT_CHART_DATA_FILE;
  const useApi = isUrl && !isJson;
  let sourceLabel = isJson ? 'ローカル JSON' : useApi ? 'Cloudflare API' : 'ローカル JSON';

  if(infoBox) infoBox.innerHTML = `<span style="color:var(--accent)">読み込み中<span class="spinner"></span></span>`;
  log(`${sourceLabel} を読み込み中...`, 'log-info');

  if(isJson){
    try {
      const res = await fetch(localPath);
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = await res.json();
      applyChartData(parsed);
      return;
    } catch(e){
      log('読み込みエラー: '+e.message, 'log-err');
      if(infoBox) infoBox.innerHTML = `<span style="color:var(--red);font-size:9px">JSON 読み込み失敗: ${localPath}</span>`;
      chartData = null;
      return;
    }
  }

  if(useApi){
    try {
      const res = await fetch(localPath);
      if(res.ok){
        const parsed = await res.json();
        applyChartData(parsed);
        return;
      }
      log(`ローカルチャート未検出: ${localPath}`, 'log-warn');
    } catch {
      log(`ローカルチャート未検出: ${localPath}`, 'log-warn');
    }

    try {
      const apiUrl = API_BASE + encodeURIComponent(rawUrl);
      const res = await fetch(apiUrl, {
        method:'GET',
        headers: {
          'Accept':'application/json',
          'Referer': API_REFERER
        }
      });
      if(!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const json = await res.json();
      applyApiResponse(json, rawUrl);
    } catch(e) {
      log('API取得エラー: '+e.message, 'log-err');
      if(infoBox) infoBox.innerHTML = `<span style="color:var(--red);font-size:9px">API 取得失敗: ${e.message}</span>`;
      chartData = null;
    }
    return;
  }

  try {
    const res = await fetch(DEFAULT_CHART_DATA_FILE);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = await res.json();
    applyChartData(parsed);
  } catch(e) {
    log('読み込みエラー: '+e.message, 'log-err');
    if(infoBox) infoBox.innerHTML = `<span style="color:var(--red);font-size:9px">${DEFAULT_CHART_DATA_FILE} の読み込みに失敗しました</span>`;
    chartData = null;
  }
}

function applyChartData(parsed) {
  const normalizedNotes = normalizeChartNotes(parsed.notes || parsed.sampleNotes || []);
  const noteCount = parsed.total_notes || parsed.totalNotes || normalizedNotes.length;
  const laneFreq = parsed.laneFreq || parsed.laneFrequency || new Array(LANES).fill(0);
  if(laneFreq.every(v=>v===0)){
    laneFreq.fill(0);
    normalizedNotes.forEach(([lane])=>{ if(lane>=0&&lane<LANES) laneFreq[lane]++; });
  }

  const diff = parsed.diff || parsed.difficulty || parsed.level || parsed.lv || 'UNKNOWN';
  const bpm = parsed.bpm_base || parsed.bpm || parsed.BPM || '';

  chartData = {
    url: parsed.url || '',
    version: parsed.ver || parsed.version || '',
    key: parsed.key || parsed.id || '',
    title: parsed.title || parsed.name || '(UNKNOWN)',
    artist: parsed.artist || parsed.composer || '',
    bpm,
    difficulty: diff,
    noteCount,
    laneFreq,
    notes: normalizedNotes,
    measureLens: parsed.measure_lens || parsed.measureLens || null
  };

  const infoBox = document.getElementById('chartInfoBox');
  if(infoBox) infoBox.innerHTML = `
    <div class="info-title">${chartData.title}</div>
    <div class="info-meta">${chartData.artist} / BPM ${chartData.bpm}</div>
    <div class="info-meta">${chartData.version?`VER ${chartData.version} / `:''}${chartData.difficulty} / ${chartData.noteCount} notes</div>
  `;
  log(`譜面読込: ${chartData.title} [${diff}] ${chartData.noteCount}notes`, 'log-ok');
  drawRefChart();
}

function clearChart() {
  chartData=null;
  selectedChart=null;
  document.getElementById('textageUrl').value='';
  const searchInput = document.getElementById('chartIndexSearch');
  if(searchInput) searchInput.value='';
  document.getElementById('chartInfoBox').innerHTML='<span style="color:var(--text-dim);font-size:9px">textage.cc URL または ./chartData.json を入力して読込ボタンを押してください</span>';
  if(chartIndex) renderChartIndexList(chartIndex.charts.slice(0, 100));
  log('譜面データクリア');
  drawRefChart();
}

// =====================================================
// リセット・エクスポート
// =====================================================
function resetMapping() {
  hitCount.fill(0); brightness.fill(0); decayTimer.fill(0); mappedOrig.fill(null);
  document.getElementById('confFill').style.width='0%';
  document.getElementById('confPct').textContent='0%';
  updateUI();
  log('マッピングリセット', 'log-info');
}

function exportResult() {
  const result = {
    timestamp: new Date().toISOString(),
    playSide,
    chartTitle: chartData?.title||null,
    difficulty: chartData?.difficulty||null,
    mapping: mappedOrig.map((orig,disp)=>({
      displayLane: disp+1,
      originalLane: orig,
      keyType: orig===null?null:(KEY_TYPE[orig-1]?'white':'black'),
      hitCount: hitCount[disp]
    })),
    totalHits: hitCount.reduce((a,b)=>a+b,0)
  };
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
  a.download=`iidx_random_${Date.now()}.json`;
  a.click();
  log('エクスポート完了','log-ok');
}

// =====================================================
// パラメータ
// =====================================================
function setParam(name, val) {
  params[name]=val;
  document.getElementById('pv'+name.charAt(0).toUpperCase()+name.slice(1)).textContent=val;
}

// =====================================================
// プレイサイド
// =====================================================
function setSide(side) {
  playSide=side;
  document.getElementById('s1p').classList.toggle('on',side==='1P');
  document.getElementById('s2p').classList.toggle('on',side==='2P');
  log('プレイサイド: '+side);
}

// =====================================================
// 初期化
// =====================================================
(function init(){
  updateUI();
  initFooterResizer();
  log('IIDX RANDOM Analyzer 起動完了','log-ok');
  log('映像ソースを選択してROIを設定してください');
  const wrap=document.querySelector('.chart-ref-canvas-wrap');
  if(wrap){
    const obs=new ResizeObserver(()=>{
      refCanvas.width=wrap.offsetWidth;
      refCanvas.height=wrap.offsetHeight;
      drawRefChart();
    });
    obs.observe(wrap);
  }
})();
