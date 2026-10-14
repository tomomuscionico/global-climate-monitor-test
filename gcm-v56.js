
const $=s=>document.querySelector(s);
const map=L.map('map',{worldCopyJump:true,zoomSnap:0.1,zoomDelta:0.5}).setView([-7,-62],3);
// Consistent English-oriented base maps across every GCM data layer.
// Raster labels are baked into the image. Esri World Street and World Topographic
// use international/English-facing cartography rather than native-script OSM raster.
// Both are fallback choices, NOT a promise that every minor feature has a translation.
// Review Esri's public-use license before hosting a public, high-traffic GCM.
const englishMap=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,maxNativeZoom:19,attribution:'Basemap © Esri and contributors'});
const street=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,maxNativeZoom:19,attribution:'Fallback basemap © Esri and contributors'});
let englishTileFailures=0;
let mapProviderSwitched=false;
englishMap.on('tileerror',()=>{
  if(++englishTileFailures>=4&&!mapProviderSwitched&&map.hasLayer(englishMap)){
    mapProviderSwitched=true;
    map.removeLayer(englishMap);
    street.addTo(map);
    const e=document.getElementById('mapLanguageNote');
    if(e)e.textContent='STREET BASEMAP UNAVAILABLE — ENGLISH-ORIENTED TOPOGRAPHIC MAP ACTIVE';
  }
});
englishMap.addTo(map);
const satellite=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Imagery © Esri and imagery providers'});
let overlay=null,active='overview',point=null,weatherRequest=0;
let baseView='map';
const markers=L.layerGroup().addTo(map), locationMarker=L.layerGroup().addTo(map);
const names={overview:'OVERVIEW',temperature:'AIR TEMPERATURE / LOCATION MODEL',rainfall:'PRECIPITATION IMAGERY (NASA)',drought:'COPERNICUS GLOBAL DROUGHT / SPI',floods:'REPORTED FLOOD EVENTS',fires:'NASA SATELLITE FIRE DETECTIONS',satellite:'SATELLITE IMAGERY'};
const status=t=>$('#status').textContent=t;

function updateSatelliteDisplay(){
  if(baseView!=='satellite')return;
  if(!map.hasLayer(satellite))satellite.addTo(map);
  satellite.bringToBack();
  status('SATELLITE VIEW · ESRI WORLD IMAGERY');
}

function setMapView(next){
  baseView=next==='satellite'?'satellite':'map';
  for(const [id,enabled] of [['viewMap',baseView==='map'],['viewSatellite',baseView==='satellite']]){
    const button=document.getElementById(id);button.classList.toggle('selected',enabled);button.setAttribute('aria-pressed',String(enabled));
  }
  if(baseView==='satellite'){
    if(map.hasLayer(street))map.removeLayer(street);if(map.hasLayer(englishMap))map.removeLayer(englishMap);
    updateSatelliteDisplay();
  }else{
    if(map.hasLayer(satellite))map.removeLayer(satellite);
    if(!map.hasLayer(street)&&!map.hasLayer(englishMap)){if(mapProviderSwitched)street.addTo(map);else englishMap.addTo(map);}
    (map.hasLayer(englishMap)?englishMap:street).bringToBack();
  }
}
document.getElementById('viewMap').onclick=()=>setMapView('map');
document.getElementById('viewSatellite').onclick=()=>setMapView('satellite');


// RainViewer: actual past radar composite frames, not decorative rain and not a forecast.
// Free RainViewer: max native zoom 7; blue palette 2; best effort and partial geographic coverage.
const radarUI=document.getElementById('radarControls');
const radarTime=document.getElementById('radarClock');
const radarExplanation=document.getElementById('radarExplanation');
const radarFrameSlider=document.getElementById('radarFrame');
let radarFrames=[],radarHost='',radarIndex=-1,radarTile=null,radarTimer=null,radarRequest=0;
let radarSeenTiles=0,radarFailedTiles=0;
const radarTimeFormat=epoch=>new Date(epoch*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC',timeZoneName:'short'});
function radarStop(){if(radarTimer){clearInterval(radarTimer);radarTimer=null;}document.getElementById('radarPlay').textContent='▶ PLAY';document.getElementById('radarPlay').setAttribute('aria-label','Play radar animation');document.getElementById('radarPlay').title='Play six recent observations';}
function radarClear(){radarStop();radarRequest++;if(radarTile){map.removeLayer(radarTile);radarTile=null;}radarUI.hidden=true;}
function radarShow(index){
 if(active!=='rainfall'||!radarFrames.length)return;
 radarIndex=Math.max(0,Math.min(index,radarFrames.length-1));
 const frame=radarFrames[radarIndex];radarSeenTiles=0;radarFailedTiles=0;
 if(radarTile){map.removeLayer(radarTile);radarTile=null;}
 // Tile size 256; upscale beyond native 7 instead of making unsupported high-zoom requests.
 const tileURL=radarHost+frame.path+'/256/{z}/{x}/{y}/2/1_1.png';
 radarTile=L.tileLayer(tileURL,{tileSize:256,maxNativeZoom:7,maxZoom:19,minZoom:0,opacity:.82,updateWhenIdle:true,keepBuffer:0,attribution:'Radar © <a href="https://www.rainviewer.com/">RainViewer</a>'});
 radarTile.on('tileload',()=>{radarSeenTiles++;if(active==='rainfall'&&radarIndex===index)status('RAIN RADAR OBSERVATIONS DISPLAYED · '+radarTimeFormat(frame.time)+' · COVERAGE VARIES');});
 radarTile.on('tileerror',()=>{radarFailedTiles++;if(radarFailedTiles>=3&&active==='rainfall'){status('RADAR TILE ERRORS · SERVICE, COVERAGE OR RATE LIMIT · NO RAIN CONCLUSION POSSIBLE');radarExplanation.textContent='Radar tiles failed. Try UPDATE later. Blank map does not mean dry conditions.';}});
 radarTile.addTo(map);
 radarFrameSlider.value=String(radarIndex);
 radarTime.textContent=radarTimeFormat(frame.time);
 radarExplanation.textContent=(radarTimer?'ANIMATING · ':'FRAME · ')+(radarIndex+1)+'/'+radarFrames.length+' · Radar echoes show regional precipitation patterns, NOT a measured rainfall total at the selected point.';
}
async function loadRainRadar(){
 radarClear();const token=++radarRequest;
 radarUI.hidden=false;radarPlayButton.disabled=true;radarTime.textContent='Loading frames…';radarExplanation.textContent='Contacting RainViewer for observed radar maps…';
 status('FETCHING OBSERVED RAIN RADAR · NOT A MODEL PRECIPITATION POINT');
 try{
  const response=await fetch('https://api.rainviewer.com/public/weather-maps.json',{cache:'no-store'});
  if(!response.ok)throw new Error('API HTTP '+response.status);
  const manifest=await response.json();
  if(token!==radarRequest||active!=='rainfall')return;
  if(!manifest.host||!Array.isArray(manifest.radar?.past)||!manifest.radar.past.length)throw new Error('No recent radar frames available');
  if(!/^https:\/\//.test(manifest.host))throw new Error('Unexpected radar tile host');
  radarHost=manifest.host;radarFrames=manifest.radar.past.slice(-6);
  radarFrameSlider.max=String(radarFrames.length-1);radarPlayButton.disabled=radarFrames.length<2;
  radarShow(radarFrames.length-1);
  status('RAIN RADAR CONNECTED · OBSERVED MAP FRAMES · COVERAGE VARIES BY REGION');
 }catch(e){if(token!==radarRequest)return;radarPlayButton.disabled=true;radarTime.textContent='Unavailable';radarExplanation.textContent='RADAR REQUEST FAILED: '+e.message+'. Try UPDATE; do not interpret as zero rainfall.';status('RADAR CONNECTION UNAVAILABLE · '+e.message);}
}
// Playback advances the observed radar frames, not a simulated rainfall effect.
// Show the first change immediately so the user gets unequivocal feedback.
const radarPlayButton=document.getElementById('radarPlay');
radarPlayButton.onclick=()=>{
 if(radarTimer){radarStop();return;}
 if(active!=='rainfall'||radarFrames.length<2){
  radarExplanation.textContent='PLAY unavailable: at least two observed radar frames must load. Select UPDATE and try again.';
  return;
 }
 const advance=()=>{
  if(active!=='rainfall'||radarFrames.length<2){radarStop();return;}
  radarShow((radarIndex+1)%radarFrames.length);
  radarPlayButton.textContent='Ⅱ PAUSE';
  radarPlayButton.setAttribute('aria-label','Pause radar animation');
  radarPlayButton.title='Radar animation playing · '+(radarIndex+1)+' / '+radarFrames.length;
 };
 // Start at the earliest frame; an immediate jump makes PLAY visibly responsive.
 if(radarIndex>=radarFrames.length-1)radarIndex=-1;
 advance();
 radarTimer=setInterval(advance,1700);
};
document.getElementById('radarLatest').onclick=()=>{radarStop();radarShow(radarFrames.length-1);};
document.getElementById('radarRefresh').onclick=()=>loadRainRadar();
radarFrameSlider.oninput=e=>{radarStop();radarShow(+e.target.value);};
// Copernicus Global Drought Observatory; standardized precipitation index layers, latest available date.
const GDO_WMS='https://drought.emergency.copernicus.eu/api/wms';
const droughtOpacity=()=>Number($('#droughtOpacity').value)/100;
// Presentation-only adaptive feathering. The SPI source grid remains unchanged.
// Larger visible source cells at high zoom need broader feathering than world views.
function gcmDroughtBlurPixels(){
 const z=map.getZoom();
 return Math.round(Math.max(3,Math.min(28,4*Math.pow(1.42,Math.max(0,z-4)))));
}
function gcmApplyDroughtSmoothing(){
 if(!droughtLayer)return;
 const el=droughtLayer.getElement();
 if(el)el.style.setProperty('--gcm-drought-blur',gcmDroughtBlurPixels()+'px');
}

let droughtLayer=null,droughtSpan='short',droughtTiles=0,droughtErrors=0,droughtEpoch=0;
let droughtManualRefresh=0;
// Monthly selection: 2020-01 through 2026-09. PLAY previews yearly steps for speed.
const GCM_DROUGHT_START=2020*12;
const GCM_DROUGHT_END=2026*12+8;
let droughtMonth=GCM_DROUGHT_END, droughtPlayTimer=null, droughtHistoryMode=true;
function droughtDate(){const y=Math.floor(droughtMonth/12),m=droughtMonth%12+1;return y+'-'+String(m).padStart(2,'0')+'-01';}
function droughtMonthLabel(){return new Date(Date.UTC(Math.floor(droughtMonth/12),droughtMonth%12,1)).toLocaleDateString('en-US',{month:'short',year:'numeric',timeZone:'UTC'}).toUpperCase();}
function updateDroughtTimeline(){ if(active==='fires')return; $('#year').min='0';$('#year').max=String(GCM_DROUGHT_END-GCM_DROUGHT_START);$('#year').value=String(droughtMonth-GCM_DROUGHT_START);$('#yeartext').textContent=droughtMonthLabel();$('#droughtBack').disabled=droughtMonth<=GCM_DROUGHT_START;$('#droughtForward').disabled=droughtMonth>=GCM_DROUGHT_END;$('#droughtPlay').textContent=droughtPlayTimer?'Ⅱ PAUSE':'▶ PLAY'; }
function stopDroughtPlayback(){if(droughtPlayTimer){droughtPlayTimer.stopped=true;droughtPlayTimer=null;}updateDroughtTimeline();}
function setDroughtMonth(v,draw=true){droughtMonth=Math.max(GCM_DROUGHT_START,Math.min(GCM_DROUGHT_END,v));updateDroughtTimeline();if(draw&&active==='drought')droughtDraw();}

// Dated drought imagery: bounded cache for repeated history playback.
// Cache keys include map bounds, pixel size, SPI layer, and requested month.
const droughtImageCache=new Map();
const DROUGHT_CACHE_LIMIT=18;
let droughtVisibleMonth=null,droughtVisibleSpan=null,droughtPlayBusy=false;
function droughtRequest(month=droughtMonth,span=droughtSpan,force=false){
 const layerName=span==='short'?'spaST':'spaLT';
 const timescale=span==='short'?'01':'06';
 const bounds=map.getBounds();
 const box=[bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()].map(x=>x.toFixed(5)).join(',');
 const width=Math.max(256,Math.min(1600,Math.round(map.getSize().x*window.devicePixelRatio)));
 const height=Math.max(256,Math.min(1200,Math.round(map.getSize().y*window.devicePixelRatio)));
 const date=(Math.floor(month/12))+'-'+String(month%12+1).padStart(2,'0')+'-01';
 const params=new URLSearchParams({SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:layerName,STYLES:'',SRS:'EPSG:4326',BBOX:box,WIDTH:String(width),HEIGHT:String(height),FORMAT:'image/png',TRANSPARENT:'TRUE',SELECTED_TIMESCALE:timescale,CROP:'land',TIME:date});
 if(force)params.set('_gcm_refresh',String(Date.now())+'_'+(++droughtManualRefresh));
 const key=layerName+'|'+timescale+'|'+date+'|'+box+'|'+width+'x'+height;
 return {url:GDO_WMS+'?'+params.toString(),key,bounds,month,span};
}
function droughtFetch(req,force=false){
 if(!force&&droughtImageCache.has(req.key))return droughtImageCache.get(req.key);
 const entry={url:req.url, state:'pending',promise:null};
 entry.promise=new Promise((resolve,reject)=>{
  const img=new Image();
  img.onload=()=>{entry.state='ready';resolve(entry);};
  img.onerror=()=>{entry.state='error';droughtImageCache.delete(req.key);reject(new Error('Image unavailable'));};
  img.src=req.url;
 });
 // Attach a handler immediately for speculative preloads on unreliable networks.
 entry.promise.catch(()=>{});
 droughtImageCache.set(req.key,entry);
 while(droughtImageCache.size>DROUGHT_CACHE_LIMIT){droughtImageCache.delete(droughtImageCache.keys().next().value);}
 return entry;
}
function droughtPreload(){
 if(active!=='drought')return;
 const next=Math.min(GCM_DROUGHT_END,droughtMonth+12);
 if(next>droughtMonth){const req=droughtRequest(next);droughtFetch(req).promise.catch(()=>{});}
}
const droughtUpdateButton=$('#droughtUpdate');
function droughtUpdateBusy(busy){droughtUpdateButton.disabled=busy;droughtUpdateButton.textContent=busy?'↻ LOADING…':'↻ UPDATE';}
function droughtStop(){
 stopDroughtPlayback();
 $('#droughtControls').hidden=true;
 droughtUpdateBusy(false);
 if(droughtLayer){map.removeLayer(droughtLayer);droughtLayer=null;}
 droughtEpoch++;
 droughtVisibleMonth=null;
}
function droughtDraw(force=false){
 if(active!=='drought')return Promise.resolve(false);
 if(force)droughtUpdateBusy(true);
 const layerName=droughtSpan==='short'?'spaST':'spaLT';
 const timescale=droughtSpan==='short'?'01':'06';
 $('#droughtShort').classList.toggle('active',droughtSpan==='short');
 $('#droughtLong').classList.toggle('active',droughtSpan==='long');
 $('#droughtTime').textContent='Copernicus GDO · requested '+droughtMonthLabel()+' · '+(droughtSpan==='short'?'1-month':'6-month')+' SPI';
 const imagePresent=droughtVisibleMonth!==null;
 $('#droughtFeedback').textContent=(imagePresent?'KEEPING PREVIOUS MAP WHILE LOADING · ':'')+'REQUESTING '+droughtMonthLabel()+'…';
 $('#droughtLegend').src=GDO_WMS+'?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetLegendGraphic&FORMAT=image/png&LAYER='+layerName+'&SELECTED_TIMESCALE='+timescale;
 const req=droughtRequest(droughtMonth,droughtSpan,force);
 const diag=$('#droughtDiagnostic');if(diag)diag.href=req.url;
 const epoch=++droughtEpoch;
 const entry=droughtFetch(req,force);
 return entry.promise.then(()=>{
  if(epoch!==droughtEpoch||active!=='drought')return false;
  // Display the already loaded image URL; don't remove the older overlay until
  // the incoming map has actually loaded in Leaflet.
  const nextLayer=L.imageOverlay(entry.url,req.bounds,{opacity:0,interactive:false,className:'gcm-drought-image',attribution:'Copernicus EMS / Global Drought Observatory'});
  return new Promise(resolve=>{
   const fail=()=>{map.removeLayer(nextLayer);if(epoch===droughtEpoch){droughtUpdateBusy(false);$('#droughtFeedback').textContent='MAP IMAGE COULD NOT BE DISPLAYED · PREVIOUS MAP RETAINED';}resolve(false);};
   nextLayer.once('error',fail);
   nextLayer.once('load',()=>{
    if(epoch!==droughtEpoch||active!=='drought'){map.removeLayer(nextLayer);resolve(false);return;}
    const previous=droughtLayer;
    droughtLayer=nextLayer;
    nextLayer.setOpacity(droughtOpacity());
    gcmApplyDroughtSmoothing();
    if(previous)map.removeLayer(previous);
    droughtVisibleMonth=req.month;droughtVisibleSpan=req.span;
    const label=new Date(Date.UTC(Math.floor(req.month/12),req.month%12,1)).toLocaleDateString('en-US',{month:'short',year:'numeric',timeZone:'UTC'}).toUpperCase();
    const checked=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    $('#droughtTime').textContent='Displayed map request: '+label+' · '+(req.span==='short'?'1-month':'6-month')+' SPI · source observation date not verified by WMS response';
    $('#droughtFeedback').textContent='MAP LOADED · REQUESTED '+label+' · checked '+checked;
    $('#gcmTimelineNote').textContent='DISPLAYED REQUEST: '+label+' · WMS image loaded; underlying observation date not independently validated';
    status('COPERNICUS DROUGHT IMAGE DISPLAYED · REQUESTED '+label);
    droughtUpdateBusy(false);droughtPreload();resolve(true);
   });
   nextLayer.addTo(map);
  });
 }).catch(()=>{
  if(epoch!==droughtEpoch||active!=='drought')return false;
  droughtUpdateBusy(false);
  $('#droughtFeedback').textContent='NO IMAGE LOADED FOR '+droughtMonthLabel()+' · PREVIOUS MAP RETAINED';
  $('#gcmTimelineNote').textContent='REQUEST FAILED: '+droughtMonthLabel()+' · previous map may remain visible';
  status('GDO REQUEST FAILED · NO NEW DATA DISPLAYED');return false;
 });
}
let droughtReloadTimer=null;
map.on('zoomend',gcmApplyDroughtSmoothing);
map.on('moveend zoomend',()=>{
 if(active!=='drought')return;
 clearTimeout(droughtReloadTimer);
 droughtReloadTimer=setTimeout(droughtDraw,350);
});
$('#droughtOpacity').oninput=()=>{$('#droughtOpacityValue').value=$('#droughtOpacity').value+'%';if(droughtLayer)droughtLayer.setOpacity(droughtOpacity());};
$('#droughtShort').onclick=()=>{droughtSpan='short';droughtDraw()};
$('#droughtLong').onclick=()=>{droughtSpan='long';droughtDraw()};
$('#droughtUpdate').onclick=()=>{clearTimeout(droughtReloadTimer);droughtDraw(true);};
// Scrub locally at full speed; download the selected image only once the user releases the slider.
let droughtScrubbing=false;
function gcmScrubPreview(value){
 if(active!=='drought')return;
 stopDroughtPlayback();clearTimeout(droughtReloadTimer);
 droughtScrubbing=true;
 setDroughtMonth(GCM_DROUGHT_START+Number(value),false);
 $('#gcmTimelineNote').textContent='SELECTED '+droughtMonthLabel()+' · RELEASE TO LOAD THE DROUGHT MAP';
}
function gcmScrubCommit(){
 if(active!=='drought'||!droughtScrubbing)return;
 droughtScrubbing=false;
 clearTimeout(droughtReloadTimer);
 droughtDraw();
}
$('#year').addEventListener('input',e=>gcmScrubPreview(e.target.value));
$('#year').addEventListener('change',gcmScrubCommit);
// Pointer release outside the thumb still commits the last selected month.
$('#year').addEventListener('pointerup',gcmScrubCommit);
$('#year').addEventListener('pointercancel',gcmScrubCommit);
$('#year').addEventListener('keyup',e=>{if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(e.key))gcmScrubCommit();});
$('#droughtBack').onclick=()=>{stopDroughtPlayback();setDroughtMonth(droughtMonth-1);};
$('#droughtForward').onclick=()=>{stopDroughtPlayback();setDroughtMonth(droughtMonth+1);};
$('#droughtCurrent').onclick=()=>{stopDroughtPlayback();setDroughtMonth(GCM_DROUGHT_END);};
$('#droughtPlay').onclick=async()=>{
 if(droughtPlayTimer){stopDroughtPlayback();return;}
 if(droughtMonth>=GCM_DROUGHT_END)setDroughtMonth(GCM_DROUGHT_START,false);
 // A non-null playback token permits immediate Pause while a network request is pending.
 const controller={stopped:false};droughtPlayTimer=controller;updateDroughtTimeline();
 while(!controller.stopped&&active==='drought'&&droughtMonth<GCM_DROUGHT_END){
  const next=Math.min(GCM_DROUGHT_END,droughtMonth+12);
  droughtMonth=next;updateDroughtTimeline();
  $('#gcmTimelineNote').textContent='LOADING '+droughtMonthLabel()+' · playback waits for imagery';
  const ok=await droughtDraw();
  if(controller.stopped||active!=='drought')break;
  if(!ok){$('#gcmTimelineNote').textContent='PLAYBACK STOPPED: '+droughtMonthLabel()+' could not load';break;}
  await new Promise(resolve=>setTimeout(resolve,650));
 }
 if(droughtPlayTimer===controller){droughtPlayTimer=null;updateDroughtTimeline();}
};
$('#droughtLegend').onerror=()=>{$('#droughtLegend').alt='Drought legend unavailable from service';$('#droughtLegend').style.display='none'};
$('#droughtLegend').onload=()=>{$('#droughtLegend').style.display='block'};

// FLOOD: forecast river discharge probabilities are not observed flood extents.
const FLOOD_WMS='https://global-flood.emergency.copernicus.eu/proxy/?srv=ows';
let floodMode='reported',floodOverlay=null,floodSeq=0,floodTimer=null;
const floodForecastMarkers=L.layerGroup().addTo(map);let floodForecastCache=null;
const gcmRiverCache=new Map(),gcmReportCache=new Map();const GCM_RIVER_TTL=10*60*1000,GCM_REPORT_TTL=15*60*1000;
function gcmCached(cache,key,ttl,loader,force=false){const old=cache.get(key),now=Date.now();if(!force&&old&&now-old.time<ttl)return old.promise;const promise=loader().catch(err=>{if(cache.get(key)?.promise===promise)cache.delete(key);throw err;});cache.set(key,{time:now,promise});if(cache.size>70)cache.delete(cache.keys().next().value);return promise;}

function floodStop(){
  floodSeq++;clearTimeout(floodTimer);
  $('#floodControls').hidden=true;
  if(floodOverlay){map.removeLayer(floodOverlay);floodOverlay=null;}
  floodForecastMarkers.clearLayers();
  $('#floodUpdate').disabled=false;$('#floodUpdate').textContent='↻ UPDATE';
}
function floodSetMode(mode){
 floodMode=mode;
 for(const [id,m] of [['floodReported','reported'],['floodNear','near'],['floodLater','later']]){
   const el=$('#'+id);el.classList.toggle('active',m===mode);el.setAttribute('aria-pressed',String(m===mode));
 }
 $('#floodLegend').hidden=mode==='reported';
 $('#floodDescription').textContent=mode==='reported'?'GDACS and NASA EONET flood reports from the past 90 days. Click markers for source records. These are not flooded-area boundaries.'
  :(mode==='near'?'Days 1–3: modeled river discharge and change from the first forecast day. Click a point for daily forecasts.'
  :'Days 4–10: modeled river discharge and change from the first forecast day. This is NOT a flood-alert or inundation map.');
 floodLoad();
}
function floodBounds(){const b=map.getBounds(),south=Math.max(-85.05,b.getSouth()),north=Math.min(85.05,b.getNorth());return L.latLngBounds([south,b.getWest()],[north,b.getEast()]);}
function floodLoad(force=false){
 if(active!=='floods')return;
 const seq=++floodSeq;
 $('#floodUpdate').disabled=true;$('#floodUpdate').textContent='LOADING…';
 if(floodOverlay){map.removeLayer(floodOverlay);floodOverlay=null;}
 if(floodMode==='reported'){markers.clearLayers();floodForecastMarkers.clearLayers();}
 else markers.clearLayers();
 $('#floodTimestamp').textContent=floodMode==='reported'?'NASA EONET events may be updated after actual flooding.':'Latest service forecast requested. Forecast issue time not independently verified.';
 if(floodMode==='reported'){
  $('#floodFeedback').textContent='CHECKING GDACS + NASA FLOOD REPORTS (PAST 90 DAYS)…';
  const toDate=new Date(),fromDate=new Date(toDate.getTime()-90*86400000);
  const asDay=d=>d.toISOString().slice(0,10);
  const gdacsURL='https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?'+new URLSearchParams({eventlist:'FL',fromdate:asDay(fromDate),todate:asDay(toDate),alertlevel:'red;orange;green'});
  const nasaURL='https://eonet.gsfc.nasa.gov/api/v3/events?category=floods&status=all&days=90&limit=500';
  const fetchJSON=url=>gcmCached(gcmReportCache,url,GCM_REPORT_TTL,async()=>{const r=await fetch(url,{cache:'default'});if(!r.ok)throw Error('HTTP '+r.status);return r.json();},force);
  const locationOf=geometry=>{
    if(!geometry)return null;
    if(geometry.type==='Point'&&geometry.coordinates?.length>=2)return geometry.coordinates;
    if(geometry.type==='MultiPoint')return geometry.coordinates?.[0];
    if(geometry.type==='Polygon')return geometry.coordinates?.[0]?.[0];
    if(geometry.type==='MultiPolygon')return geometry.coordinates?.[0]?.[0]?.[0];
    return null;
  };
  const addReport=(longitude,latitude,meta,color)=>{
    const lon=Number(longitude),lat=Number(latitude);
    if(!Number.isFinite(lon)||!Number.isFinite(lat)||Math.abs(lat)>90||Math.abs(lon)>180)return false;
    const title=meta?.title||'Flood report';
    const source=meta?.source||'Reported source';
    const date=meta?.date?String(meta.date).slice(0,19):'Date unavailable';
    const wrapper=document.createElement('div');wrapper.className='gcm-flood-report';
    const heading=document.createElement('strong');heading.textContent=title;wrapper.append(heading);
    const placeLine=document.createElement('p');placeLine.style.margin='6px 0 4px';placeLine.textContent='Looking up nearby place…';wrapper.append(placeLine);
    const coordLine=document.createElement('small');coordLine.textContent='Coordinates: '+lat.toFixed(4)+'°, '+lon.toFixed(4)+'°';wrapper.append(coordLine);
    const sourceLine=document.createElement('p');sourceLine.textContent='Source: '+source+' · Reported event';wrapper.append(sourceLine);
    const timeLine=document.createElement('p');timeLine.textContent='Event date: '+date;wrapper.append(timeLine);
    const detailBits=[];
    if(meta?.status)detailBits.push('Status: '+meta.status);
    if(meta?.alert)detailBits.push('Alert: '+meta.alert);
    if(meta?.severity)detailBits.push('Severity: '+meta.severity);
    if(meta?.category)detailBits.push('Category: '+meta.category);
    if(meta?.sourcesText)detailBits.push('Feeds: '+meta.sourcesText);
    if(meta?.eventId)detailBits.push('ID: '+meta.eventId);
    const detailLine=document.createElement('p');
    detailLine.textContent=detailBits.length?detailBits.join(' · '):(source==='NASA EONET'?'NASA event feed location; this is a reported event point, not a mapped flood extent.':'GDACS event location; this is a reported event point, not a mapped flood extent.');
    wrapper.append(detailLine);
    if(meta?.description){
      const desc=document.createElement('p');desc.textContent=String(meta.description).slice(0,240);wrapper.append(desc);
    }
    if(meta?.link&&/^https:\/\//i.test(meta.link)){
      const a=document.createElement('a');a.href=meta.link;a.rel='noopener noreferrer';a.target='_blank';a.textContent='Source report ↗';wrapper.append(a);
    }
    const marker=L.circleMarker([lat,lon],{radius:8,color:'#fff',weight:1.5,fillColor:color,fillOpacity:.85})
      .bindPopup(wrapper,{maxWidth:360}).addTo(markers);
    marker.on('popupopen',()=>gcmFloodResolvePlace([lat,lon],placeLine,marker));
    return true;
  };
  Promise.allSettled([fetchJSON(gdacsURL),fetchJSON(nasaURL)]).then(results=>{
    if(seq!==floodSeq||active!=='floods'||floodMode!=='reported')return;
    let gdCount=0,nasaCount=0;const notes=[];
    if(results[0].status==='fulfilled'){
      const data=results[0].value;
      const entries=Array.isArray(data)?data:Array.isArray(data.features)?data.features:Array.isArray(data.events)?data.events:Array.isArray(data.results)?data.results:[];
      for(const item of entries){
        const p=item.properties||item;
        const c=locationOf(item.geometry||p.geometry)|| (Number.isFinite(Number(p.longitude??p.lon))&&Number.isFinite(Number(p.latitude??p.lat))?[p.longitude??p.lon,p.latitude??p.lat]:null);
        if(!c)continue;
        const title=p.name||p.title||p.eventname||p.description||'GDACS flood report';
        const date=p.fromdate||p.todate||p.date||p.pubDate;
        const link=p.url?.url||p.url||p.link|| (p.eventid?'https://www.gdacs.org/report.aspx?eventtype=FL&eventid='+encodeURIComponent(p.eventid):'https://www.gdacs.org/');
        if(addReport(c[0],c[1],{title,source:'GDACS',date,link,eventId:p.eventid||p.eventidGdacs||'',alert:p.alertlevel||p.alertLevel||p.severity||'',severity:p.severity||p.score||'',status:p.status||p.phase||'',category:p.eventtype||p.category||'Flood',description:p.description||p.summary||''},'#ee8350'))gdCount++;
      }
      if(!entries.length)notes.push('GDACS RESPONSE HAD NO MAPPABLE EVENTS');
      else if(!gdCount)notes.push('GDACS RETURNED '+entries.length+' RECORDS BUT NO USABLE COORDINATES');
    }else notes.push('GDACS UNAVAILABLE: '+results[0].reason.message);
    if(results[1].status==='fulfilled'){
      for(const e of results[1].value.events||[]){
        const g=e.geometry?.at(-1),c=locationOf(g);
        if(c&&addReport(c[0],c[1],{title:e.title,source:'NASA EONET',date:g.date,link:e.link||'https://eonet.gsfc.nasa.gov/',eventId:e.id||'',status:e.closed?'Closed':'Open / archive feed',category:(e.categories||[]).map(x=>x.title||x.id).filter(Boolean).join(', '),sourcesText:(e.sources||[]).map(x=>x.id).filter(Boolean).join(', ')||'',description:e.description||''},'#267fe0'))nasaCount++;
      }
    }else notes.push('NASA UNAVAILABLE: '+results[1].reason.message);
    const total=gdCount+nasaCount;
    $('#floodFeedback').textContent=total+' REPORTED FLOOD LOCATIONS · GDACS '+gdCount+' / NASA '+nasaCount+' · LAST 90 DAYS'+(notes.length?' · '+notes.join(' · '):'')+'.'+(total?' ZOOM OUT TO SEE WORLDWIDE REPORTS.':' NO RECORDS DISPLAYED; THIS DOES NOT MEAN NO FLOODS.');
    $('#floodTimestamp').textContent='Latest source check '+new Date().toLocaleString()+' · reports may be delayed, duplicate or incomplete. Orange: GDACS; blue: NASA. Event reports ≠ mapped inundation.';
    status(total?'FLOOD REPORTS MAPPED: '+total+' · GDACS + NASA · SELECT A MARKER':'NO FLOOD REPORTS DISPLAYED · VERIFY SOURCES; NOT A NO-FLOOD CLAIM');
  }).finally(()=>{if(seq===floodSeq){$('#floodUpdate').disabled=false;$('#floodUpdate').textContent='↻ UPDATE';}});
  return;
 }
 // Accessible Copernicus GloFAS daily river discharge forecasts via Open-Meteo.
 // Resolve approximate location lazily: never reverse-geocode every model point.
 const gcmFloodPlaceCache=new Map();let gcmFloodPlaceLastLookup=0;
 async function gcmFloodResolvePlace(center,el,marker){
   const key=center.map(x=>x.toFixed(3)).join(',');
   if(gcmFloodPlaceCache.has(key)){el.textContent=gcmFloodPlaceCache.get(key);return;}
   el.textContent='Looking up nearby place…';
   // Respect the public Nominatim service's low-volume use limit.
   const wait=Math.max(0,1150-(Date.now()-gcmFloodPlaceLastLookup));
   gcmFloodPlaceLastLookup=Date.now()+wait;
   if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
   try{
     const url='https://nominatim.openstreetmap.org/reverse?format=json&lat='+encodeURIComponent(center[0])+'&lon='+encodeURIComponent(center[1])+'&zoom=10&addressdetails=1&accept-language=en';
     const r=await fetch(url,{headers:{'Accept-Language':'en'}});
     if(!r.ok)throw Error('HTTP '+r.status);
     const d=await r.json(),a=d.address||{};
     const locality=a.city||a.town||a.village||a.municipality||a.county||a.state||a.region||'';
     const country=a.country||'';
     const name=[locality,country].filter(Boolean).join(', ');
     if(!name)throw Error('No nearby locality available');
     const label='Near '+name;
     gcmFloodPlaceCache.set(key,label);
     if(marker.isPopupOpen())el.textContent=label;
   }catch(e){if(marker.isPopupOpen())el.textContent='Near '+center[0].toFixed(3)+'°, '+center[1].toFixed(3)+'° (place unavailable)';}
 }
 // Rise from day 1 is NOT an official flood-return-period exceedance or flood probability.
 const worldSites=[
 [-3.13,-60.02],[-1.45,-48.49],[-8.75,-63.9],[-12.05,-77.04],[9.02,-79.52],
 [29.76,-95.37],[38.6,-90.2],[35.15,-90.05],[45.5,-73.57],[49.27,-123.12],
 [51.51,-.13],[48.85,2.35],[50.11,8.68],[47.5,19.04],[44.82,20.46],
 [30.04,31.24],[15.6,32.53],[9.03,38.74],[0.35,32.58],[-4.33,15.31],
 [-15.78,35],[-17.83,31.05],[-17.84,25.86],[-1.29,36.82],[30.53,114.35],
 [22.55,114.05],[23.13,113.26],[31.23,121.47],[25.04,121.56],[13.75,100.5],
 [16.84,96.17],[23.81,90.41],[24.37,88.6],[26.7,88.43],[27.71,85.32],
 [19.07,72.88],[25.59,85.14],[34.55,69.2],[10.82,106.63],[-6.2,106.82],
 [-7.26,112.75],[14.6,120.98],[-6.8,39.28],[-33.87,151.2]
 ];
 const bbox=map.getBounds(),z=map.getZoom();
 let sites;
 if(z<=4){sites=worldSites.filter(c=>bbox.contains(L.latLng(c[0],c[1])));if(sites.length<8)sites=worldSites.slice();}
 else {
   sites=[];
   const south=Math.max(-70,bbox.getSouth()),north=Math.min(75,bbox.getNorth());
   const west=bbox.getWest(),east=bbox.getEast();
   for(let y=0;y<5;y++)for(let x=0;x<7;x++){
     const lat=south+(north-south)*(y+.5)/5,lon=west+(east-west)*(x+.5)/7;
     if(Math.abs(lat)<=85&&Math.abs(lon)<=180)sites.push([lat,lon]);
   }
   if(point&&bbox.contains([point.lat,point.lon]))sites.unshift([point.lat,point.lon]);
 }
 sites=sites.slice(0,45);
 const batches=[];for(let i=0;i<sites.length;i+=12)batches.push(sites.slice(i,i+12));
 const sourceURL='https://flood-api.open-meteo.com/v1/flood';
 $('#floodFeedback').textContent='CHECKING '+sites.length+' RIVER FORECAST POINTS · PREVIOUS RESULTS STAY VISIBLE WHILE DATA LOADS…';
 $('#floodTimestamp').textContent='MODEL FORECAST, NOT OBSERVED FLOODING. Comparing forecast river flow with forecast day 1. Not an official flood-risk threshold.';
 const validNum=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
 const requestBatch=batch=>{
   const q=new URLSearchParams({latitude:batch.map(p=>p[0].toFixed(4)).join(','),longitude:batch.map(p=>p[1].toFixed(4)).join(','),daily:'river_discharge,river_discharge_mean,river_discharge_max',forecast_days:'11',timezone:'GMT'});
   const key=q.toString();
   return gcmCached(gcmRiverCache,key,GCM_RIVER_TTL,async()=>{
     const r=await fetch(sourceURL+'?'+q,{cache:'default'});if(!r.ok)throw Error('HTTP '+r.status);
     const d=await r.json();return Array.isArray(d)?d:[d];
   },force);
 };
 Promise.allSettled(batches.map(requestBatch)).then(outcomes=>{
   if(seq!==floodSeq||active!=='floods'||floodMode==='reported')return;
   floodForecastMarkers.clearLayers();
   let plotted=0,rejected=0,failed=0, rising=0;const startDay=floodMode==='near'?0:3,endDay=floodMode==='near'?3:10;
   for(const result of outcomes){
     if(result.status!=='fulfilled'){failed++;continue;}
     for(const item of result.value){
       const d=item.daily||{},v=d.river_discharge||[],days=d.time||[];
       if(v.length<10||!validNum(v[0])){rejected++;continue;}
       const period=v.slice(startDay,endDay).filter(validNum);
       if(!period.length){rejected++;continue;}
       const peak=Math.max(...period),day0=v[0],delta=peak-day0;
       if(day0<2&&peak<5){rejected++;continue;}
       const pct=day0>2?100*delta/day0:null;
       const strong=delta>=20&&pct!==null&&pct>=60;
       const up=delta>=5&&pct!==null&&pct>=20;
       if(strong||up)rising++;
       const color=strong?'#f6aa3e':up?'#52b6e5':'#b9cbc8';
       const center=[item.latitude,item.longitude];
       if(!center.every(Number.isFinite))continue;
       const radius=(strong?10:up?8:5)*Number($('#floodOpacity').value)/70;
       // Make each model point understandable, without inventing a nearby river name.
       // Location lookup occurs only when a visitor opens a marker, protecting mobile bandwidth.
       const content=document.createElement('div');content.className='gcm-flood-point';
       const heading=document.createElement('strong');heading.textContent='FORECAST LOCATION';content.append(heading);
       const placeLine=document.createElement('p');placeLine.style.margin='5px 0';placeLine.textContent='Near '+center[0].toFixed(3)+'°, '+center[1].toFixed(3)+'°';content.append(placeLine);
       const coordLine=document.createElement('small');coordLine.textContent='Sample coordinates: '+center[0].toFixed(4)+'°, '+center[1].toFixed(4)+'°';content.append(coordLine);
       const a=document.createElement('p');a.textContent='River-flow forecast · '+(floodMode==='near'?'next 1–3 days':'days 4–10')+' · Peak '+peak.toFixed(1)+' m³/s';content.append(a);
       const peakIndex=v.findIndex((x,i)=>i>=startDay&&i<endDay&&x===peak);
       const dateLine=document.createElement('p');dateLine.textContent='Highest modeled flow: '+(days[peakIndex]||'date unavailable')+' · First forecast day: '+day0.toFixed(1)+' m³/s';content.append(dateLine);
       const b=document.createElement('p');b.textContent='Change versus first forecast day: '+(delta>=0?'+':'')+delta.toFixed(1)+' m³/s'+(pct===null?'':' ('+(pct>=0?'+':'')+pct.toFixed(0)+'%)');content.append(b);
       const trend=document.createElement('p');trend.textContent=strong?'Strong modeled rise compared with first forecast day':up?'Modeled river flow rising':'No substantial rise detected relative to first forecast day';content.append(trend);
       const c=document.createElement('small');c.textContent='Forecast period: '+(days[startDay]||'unknown')+' to '+(days[endDay-1]||'unknown')+' UTC · Source: Copernicus GloFAS via Open-Meteo. Sample represents a modeled river-grid location; the nearby place name is only a geographic reference, not a verified river name. This is NOT flood probability, a flood warning, or confirmed inundation.';content.append(c);
       const marker=L.circleMarker(center,{radius,color:'#0d1e19',weight:1.5,fillColor:color,fillOpacity:.88}).bindPopup(content,{maxWidth:360}).addTo(floodForecastMarkers);
       marker.on('popupopen',()=>gcmFloodResolvePlace(center,placeLine,marker));
       plotted++;
     }
   }
   const label=floodMode==='near'?'1–3 DAYS':'4–10 DAYS';
   $('#floodFeedback').textContent=plotted+' RIVER FORECAST POINTS · '+rising+' SHOW MEANINGFUL RISE · '+label+(failed?' · '+failed+' BATCHES FAILED':'')+'. ZOOM IN FOR LOCAL DETAIL. CLICK MARKERS FOR m³/s VALUES.';
   $('#floodTimestamp').textContent='GloFAS model via Open-Meteo · forecast retrieved '+new Date().toLocaleString()+' · Changes compared with day 1 only, not historical flood thresholds. No markers ≠ no flood risk.';
   status('RIVER FLOW FORECAST READY · '+plotted+' POINTS · 10-MIN CACHE · NOT A FLOOD WARNING');
   if(!plotted)$('#floodFeedback').textContent='NO USABLE FORECAST POINTS RETURNED'+(failed?' · API REQUEST FAILED IN '+failed+' GROUP(S)':' · TRY ZOOMING TO A MAJOR RIVER')+' · THIS DOES NOT MEAN NO FLOOD RISK.';
 }).catch(err=>{if(seq===floodSeq)$('#floodFeedback').textContent='FLOOD FORECAST UNAVAILABLE · CHECK CONNECTION OR RETRY: '+err.message;}).finally(()=>{
   if(seq===floodSeq){$('#floodUpdate').disabled=false;$('#floodUpdate').textContent='↻ UPDATE';}
 });
}
$('#floodReported').onclick=()=>floodSetMode('reported');
$('#floodNear').onclick=()=>floodSetMode('near');
$('#floodLater').onclick=()=>floodSetMode('later');
$('#floodUpdate').onclick=()=>floodLoad(true);
map.on('moveend zoomend',()=>{if(active!=='floods'||floodMode==='reported')return;clearTimeout(floodTimer);floodTimer=setTimeout(()=>floodLoad(),500);});


// FIRE MONITOR — public NASA GIBS thermal anomaly raster and EONET reported events.
// The GIBS WMS does not expose per-pixel incident identifiers. We never invent them.
let fireMode='detected',fireOffset=1,fireRaster=null,fireRequest=0;
// Historical wildfire map: one actual dated NASA VIIRS observation, NOT total monthly burning.
const GCM_FIRE_START=2020*12,GCM_FIRE_END=2026*12+8;
let fireHistoryMonth=GCM_FIRE_END,fireHistoryPlaying=false,fireHistoryTimer=null,fireHistoryScrubbing=false;
const fireHistoryDate=()=>{const y=Math.floor(fireHistoryMonth/12),m=fireHistoryMonth%12+1;return y+'-'+String(m).padStart(2,'0')+'-15';};
const fireHistoryLabel=()=>new Date(Date.UTC(Math.floor(fireHistoryMonth/12),fireHistoryMonth%12,15)).toLocaleDateString('en-US',{month:'short',year:'numeric',timeZone:'UTC'}).toUpperCase();
function fireHistoryStop(){fireHistoryPlaying=false;if(fireHistoryTimer){clearTimeout(fireHistoryTimer);fireHistoryTimer=null;}if(active==='fires')fireHistoryUI();}
function fireHistoryUI(){
 if(active!=='fires'||fireMode!=='detected')return;
 const timeline=$('#gcmHistoricalTimeline');timeline.style.display='block';
 timeline.querySelector('.gcm-time-head .fine').textContent='WILDFIRE HISTORY · NASA VIIRS / SINGLE DAY';
 $('#year').min='0';$('#year').max=String(GCM_FIRE_END-GCM_FIRE_START);$('#year').step='1';if(!fireHistoryScrubbing)$('#year').value=String(fireHistoryMonth-GCM_FIRE_START);
 $('#year').setAttribute('aria-label','Historical satellite wildfire observation month');
 $('#yeartext').textContent=fireHistoryLabel();
 $('#droughtBack').disabled=fireHistoryMonth<=GCM_FIRE_START;
 $('#droughtForward').disabled=fireHistoryMonth>=GCM_FIRE_END;
 $('#droughtPlay').textContent=fireHistoryPlaying?'Ⅱ PAUSE':'▶ PLAY';
 $('#gcmTimelineNote').textContent='DATE: '+fireHistoryDate()+' · ONE DAY OF DETECTIONS, NOT A MONTHLY FIRE TOTAL';
}
function fireHistorySet(month,load=true){
 fireHistoryMonth=Math.max(GCM_FIRE_START,Math.min(GCM_FIRE_END,month));fireHistoryUI();
 if(load&&active==='fires'&&fireMode==='detected')fireLoad();
}
function fireHistoryStep(){
 if(!fireHistoryPlaying||active!=='fires'||fireMode!=='detected'){fireHistoryStop();return;}
 fireHistorySet(fireHistoryMonth>=GCM_FIRE_END?GCM_FIRE_START:Math.min(GCM_FIRE_END,fireHistoryMonth+12));
 fireHistoryTimer=setTimeout(fireHistoryStep,2100);
}

const firePlaceCache=new Map();
let fireLastReverse=0;
async function fireResolvePlace(lat,lon,output,marker){
 const key=lat.toFixed(3)+','+lon.toFixed(3);
 if(firePlaceCache.has(key)){output.textContent=firePlaceCache.get(key);return;}
 output.textContent='Finding nearest named place…';
 const delay=Math.max(0,1150-(Date.now()-fireLastReverse));
 fireLastReverse=Date.now()+delay;
 if(delay)await new Promise(r=>setTimeout(r,delay));
 try{
  const r=await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat='+encodeURIComponent(lat)+'&lon='+encodeURIComponent(lon)+'&zoom=10&addressdetails=1&accept-language=en',{headers:{'Accept-Language':'en'}});
  if(!r.ok)throw Error('Lookup unavailable');
  const j=await r.json(),a=j.address||{};
  const near=[a.city||a.town||a.village||a.municipality||a.county||a.state||a.region,a.country].filter(Boolean).join(', ');
  if(!near)throw Error('Place not identified');
  const label='Near '+near;firePlaceCache.set(key,label);if(marker.isPopupOpen())output.textContent=label;
 }catch(e){if(marker.isPopupOpen())output.textContent='Nearest place unavailable · coordinates below';}
}

const fireService='https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
const fireLayerName='VIIRS_SNPP_Thermal_Anomalies_375m_All';
const fireISO=(daysAgo)=>{const d=new Date();d.setUTCHours(12,0,0,0);d.setUTCDate(d.getUTCDate()-daysAgo);return d.toISOString().slice(0,10);};
const fireStatus=t=>{$('#fireFeedback').textContent=t;status(t);};
function fireClear(){fireHistoryStop();fireRequest++;if(fireRaster){map.removeLayer(fireRaster);fireRaster=null;}$('#fireControls').hidden=true;}
function fireControlsUpdate(){
 $('#fireDetected').classList.toggle('active',fireMode==='detected');
 $('#fireReported').classList.toggle('active',fireMode==='reported');
}
function fireLoad(force=false){
 const seq=++fireRequest;
 const updateButton=$('#fireUpdate');
 updateButton.disabled=true;updateButton.textContent='LOADING…';
 const fireDone=()=>{if(seq===fireRequest){updateButton.disabled=false;updateButton.textContent='↻ UPDATE';}};
 fireControlsUpdate();
 if(fireRaster){map.removeLayer(fireRaster);fireRaster=null;}
 markers.clearLayers();
 if(fireMode==='reported'){
   $('#fireDate').textContent='NASA REPORTED WILDFIRE EVENTS · PAST 90 DAYS';
   fireStatus('REQUESTING REPORTED WILDFIRES…');
   const url='https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=all&days=90&limit=350';
   fetch(url+(force?'&refresh='+Date.now():''),{cache:force?'no-store':'default'}).then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.json()}).then(data=>{
    if(seq!==fireRequest||active!=='fires'||fireMode!=='reported')return;
    let total=0;
    for(const e of data.events||[]){
      const g=e.geometry?.at(-1);if(g?.type!=='Point')continue;
      const lon=Number(g.coordinates?.[0]),lat=Number(g.coordinates?.[1]);
      if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;
      const pane=document.createElement('div');pane.className='gcm-fire-report';
      const h=document.createElement('strong');h.textContent=e.title||'Reported wildfire';pane.append(h);
      const place=document.createElement('p');place.textContent='Nearest place: loading on click…';pane.append(place);
      const coord=document.createElement('p');coord.textContent='Reported location: '+lat.toFixed(4)+'°, '+lon.toFixed(4)+'°';pane.append(coord);
      const when=document.createElement('p');when.textContent='Latest mapped event observation: '+(g.date?String(g.date).slice(0,16).replace('T',' ')+' UTC':'Not supplied');pane.append(when);
      const began=e.geometry?.[0]?.date;
      if(began&&began!==g.date){const first=document.createElement('p');first.textContent='First mapped observation: '+String(began).slice(0,16).replace('T',' ')+' UTC';pane.append(first);}
      const details=document.createElement('p');details.textContent='Source: NASA EONET · '+(e.closed?'Archived / closed':'Listed open')+' · Event ID: '+(e.id||'not supplied');pane.append(details);
      // EONET magnitude is not always area; never interpret an arbitrary magnitude as burned acreage.
      const mag=Number(e.magnitudeValue), magUnit=String(e.magnitudeUnit||'').trim();
      const magnitudeIsArea=Number.isFinite(mag)&&mag>=0&&/^(ha|hectares?|acres?|sq\.?\s?km|km[²2]|square\s?kilomet(?:er|re)s?|sq\.?\s?mi|mi[²2]|square\s?miles?)$/i.test(magUnit);
      const impact=document.createElement('div');impact.className='gcm-fire-impact';
      const impactTitle=document.createElement('strong');impactTitle.textContent='FIRE IMPACT';impact.append(impactTitle);
      const makeImpact=(label,value)=>{const row=document.createElement('p');const b=document.createElement('b');b.textContent=label+': ';row.append(b,document.createTextNode(value));impact.append(row);};
      makeImpact('Area burned',magnitudeIsArea?mag.toLocaleString()+' '+magUnit+' (source-reported)':'Not reported for this event');
      const description=String(e.description||'').trim();
      makeImpact('What burned',description?'See source description below — vegetation type not independently verified':'Vegetation / land cover not specified by NASA EONET');
      makeImpact('Environmental effects','Not assessed in this event feed');
      if(Number.isFinite(mag)&&!magnitudeIsArea){makeImpact('Other reported magnitude',mag+' '+(magUnit||'units unspecified')+(e.magnitudeDescription?' · '+String(e.magnitudeDescription):''));}
      pane.append(impact);
      const feeds=(e.sources||[]).map(x=>x.id).filter(Boolean);
      if(feeds.length){const f=document.createElement('p');f.textContent='Reporting feeds: '+feeds.join(', ');pane.append(f);}
      if(description){const desc=document.createElement('p');desc.textContent='Source description: '+description.slice(0,320);pane.append(desc);}
      const note=document.createElement('p');note.className='fire-report-note';note.textContent='Event location only. Satellite hotspots do not measure total burned area; impacts require separate burned-area and land-cover datasets.';pane.append(note);
      const link=document.createElement('a');link.href=e.link||'https://eonet.gsfc.nasa.gov/';link.target='_blank';link.rel='noopener noreferrer';link.textContent='NASA source report ↗';pane.append(link);
      const areaLink=document.createElement('a');areaLink.href='https://firms.modaps.eosdis.nasa.gov/map/';areaLink.target='_blank';areaLink.rel='noopener noreferrer';areaLink.textContent='Explore NASA fire and burned-area data ↗';areaLink.style.display='block';areaLink.style.marginTop='7px';pane.append(areaLink);
      const fireMarker=L.circleMarker([lat,lon],{radius:7,color:'#ffe9b6',fillColor:'#e36631',fillOpacity:.85,weight:1.5}).bindPopup(pane,{maxWidth:350}).addTo(markers);
      fireMarker.on('popupopen',()=>fireResolvePlace(lat,lon,place,fireMarker));total++;
    }
    fireStatus(total+' REPORTED WILDFIRE EVENTS MAPPED · PAST 90 DAYS · CHECKED '+new Date().toLocaleTimeString()+' · CLICK MARKERS FOR DETAILS');
   }).catch(e=>{if(seq===fireRequest&&active==='fires')fireStatus('NASA EONET REQUEST FAILED: '+e.message+' · RETRY UPDATE');}).finally(fireDone);
   return;
 }
 const date=fireHistoryDate();
 $('#fireDate').textContent='VIIRS SATELLITE DETECTIONS · '+date+' UTC · SINGLE-DAY SNAPSHOT';
 fireStatus('REQUESTING NASA SATELLITE FIRE DETECTIONS FOR '+date+'…');
 let success=false,errors=0;
 fireRaster=L.tileLayer.wms(fireService,{
  layers:fireLayerName,format:'image/png',transparent:true,version:'1.1.1',time:date,
  opacity:.88,maxZoom:18,attribution:'NASA GIBS / VIIRS thermal anomalies',
  ...(force?{_refresh:String(Date.now())}:{})
 });
 fireRaster.on('tileload',()=>{if(seq!==fireRequest||fireMode!=='detected'||active!=='fires')return;
  if(!success){success=true;fireDone();fireStatus('NASA VIIRS FIRE-DETECTION IMAGE LOADED · '+date+' UTC · CHECKED '+new Date().toLocaleTimeString()+' · NO DETECTIONS ≠ NO FIRES');}
 });
 fireRaster.on('tileerror',()=>{if(seq!==fireRequest||fireMode!=='detected'||active!=='fires')return;
  if(++errors>=3&&!success){fireDone();fireStatus('NASA SATELLITE LAYER UNAVAILABLE FOR '+date+' · TRY UPDATE');}
 });
 fireRaster.addTo(map);
 // Prevent a stalled network request from leaving UPDATE disabled indefinitely.
 setTimeout(fireDone,12000);
}
$('#fireDetected').onclick=()=>{if(fireMode!=='detected'){fireMode='detected';fireHistoryUI();fireLoad();}};
$('#fireReported').onclick=()=>{if(fireMode!=='reported'){fireHistoryStop();fireMode='reported';$('#gcmHistoricalTimeline').style.display='none';fireLoad();}};
$('#fireUpdate').onclick=()=>fireLoad(true);

// Share the prominent timeline without invoking the drought listeners while viewing fires.
// Capture-phase handlers stop propagation only in wildfire mode.
function fireTimelineCapture(id,event,fn){$(id).addEventListener(event,e=>{
 if(active!=='fires'||fireMode!=='detected')return;
 e.stopImmediatePropagation();fn(e);
},true);}
// Wildfire manual scrubbing: do not reset the native range input while dragging.
// Handle the pointer position explicitly so Safari desktop and touch both work.
const fireSlider=$('#year');
let firePointerDragging=false;
const fireSliderActive=()=>active==='fires'&&fireMode==='detected';
function fireScrubAt(clientX){
 const rect=fireSlider.getBoundingClientRect();
 if(!rect.width)return;
 const ratio=Math.max(0,Math.min(1,(clientX-rect.left)/rect.width));
 const value=Math.round(ratio*(GCM_FIRE_END-GCM_FIRE_START));
 fireSlider.value=String(value);
 fireHistoryScrubbing=true;
 fireHistoryMonth=GCM_FIRE_START+value;
 $('#yeartext').textContent=fireHistoryLabel();
 $('#gcmTimelineNote').textContent='SELECTED '+fireHistoryLabel()+' · RELEASE TO LOAD SATELLITE DETECTIONS';
}
function fireCommit(){
 if(!fireHistoryScrubbing)return;
 fireHistoryScrubbing=false;
 fireHistoryUI();
 fireLoad();
}
fireSlider.addEventListener('pointerdown',e=>{
 if(!fireSliderActive())return;
 e.preventDefault();e.stopImmediatePropagation();
 fireHistoryStop();firePointerDragging=true;
 try{fireSlider.setPointerCapture(e.pointerId);}catch(_){}
 fireScrubAt(e.clientX);
},true);
fireSlider.addEventListener('pointermove',e=>{
 if(!fireSliderActive()||!firePointerDragging)return;
 e.preventDefault();e.stopImmediatePropagation();
 fireScrubAt(e.clientX);
},true);
for(const evt of ['pointerup','pointercancel'])fireSlider.addEventListener(evt,e=>{
 if(!fireSliderActive()||!firePointerDragging)return;
 e.preventDefault();e.stopImmediatePropagation();
 if(evt==='pointerup')fireScrubAt(e.clientX);
 firePointerDragging=false;
 try{fireSlider.releasePointerCapture(e.pointerId);}catch(_){}
 fireCommit();
},true);
fireTimelineCapture('#year','input',e=>{
 if(firePointerDragging)return;
 fireHistoryStop();fireHistoryScrubbing=true;
 fireHistoryMonth=GCM_FIRE_START+Number(e.target.value);
 $('#yeartext').textContent=fireHistoryLabel();
 $('#gcmTimelineNote').textContent='SELECTED '+fireHistoryLabel()+' · RELEASE TO LOAD SATELLITE DETECTIONS';
});
fireTimelineCapture('#year','change',fireCommit);
fireTimelineCapture('#year','keyup',e=>{
 if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(e.key))fireCommit();
});
fireTimelineCapture('#droughtBack','click',()=>{fireHistoryStop();fireHistorySet(fireHistoryMonth-1);});
fireTimelineCapture('#droughtForward','click',()=>{fireHistoryStop();fireHistorySet(fireHistoryMonth+1);});
fireTimelineCapture('#droughtCurrent','click',()=>{fireHistoryStop();fireHistorySet(GCM_FIRE_END);});
fireTimelineCapture('#droughtPlay','click',()=>{
 if(fireHistoryPlaying){fireHistoryStop();return;}
 fireHistoryPlaying=true;fireHistoryUI();fireHistoryStep();
});


function setLayer(k){$('#gcmHistoricalTimeline').style.display=(k==='drought'||(k==='fires'&&fireMode==='detected'))?'block':'none';$('.time').style.display='none';if(k!=='drought')droughtStop();if(k!=='floods')floodStop();if(k!=='fires')fireClear();if(k!=='rainfall')radarClear();if(k!=='temperature')temperatureClear();active=k;syncWeatherMotion();document.querySelectorAll('[data-layer]').forEach(b=>b.classList.toggle('active',b.dataset.layer===k));$('#maplabel').textContent='GLOBAL VIEW / '+(k==='temperature'?'AIR TEMPERATURE / REGIONAL MODEL FORECAST':k==='rainfall'?'OBSERVED REGIONAL RADAR / POINT MODEL SEPARATE':names[k]);if(overlay){map.removeLayer(overlay);overlay=null;}markers.clearLayers();refreshLayerInsight();if(k==='overview'){
  setMapView('map');
  // A true fresh-start action, not just a layer switch.
  weatherRequest++; // invalidate any pending location weather and historical requests
  point=null;
  locationMarker.clearLayers();
  $('#clearLocationPin').hidden=true;
  $('#search').value='';
  $('#place').textContent='SELECT A LOCATION';
  $('#coords').textContent='Open-Meteo current model conditions';
  for(const id of ['temp','rain','wind','humidity'])$('#'+id).textContent='—';
  $('#timeinfo').textContent='No location selected.';
  $('#climatecompare').textContent='Choose a location to see the historical comparison.';
  setDroughtMonth(GCM_DROUGHT_END,false);
  syncWeatherMotion();
  map.setView([15,0],2,{animate:true});
  status('GLOBAL OVERVIEW RESET · SEARCH A NEW LOCATION');
  refreshLayerInsight();
  return;
}if(k==='fires'){$('#fireControls').hidden=false;fireMode='detected';fireHistoryMonth=GCM_FIRE_END;fireHistoryUI();fireLoad();refreshLayerInsight();return;}if(k==='floods'){$('.time').style.display='none';$('#floodControls').hidden=false;floodSetMode('reported');refreshLayerInsight();return;}if(k==='drought'){
  $('#gcmHistoricalTimeline .gcm-time-head .fine').textContent='DROUGHT HISTORY · COPERNICUS SPI';
  $('#year').setAttribute('aria-label','Drought observation month');
  $('.time').style.display='block';
  updateDroughtTimeline();
  $('#droughtControls').hidden=false;
  status('REQUESTING COPERNICUS GLOBAL DROUGHT OBSERVATORY / SPI · LATEST AVAILABLE');
  droughtDraw();return;
}
if(k==='temperature'||k==='rainfall'){
  if(k==='rainfall'){
    status('LOADING OBSERVED REGIONAL RAIN RADAR · OPEN-METEO POINT VALUES MAY DIFFER');
    refreshLayerInsight();loadRainRadar();return;
  }
  status('TEMPERATURE · FETCHING OPEN-METEO REGIONAL MODEL GRID');
  refreshLayerInsight();loadTemperatureField();return;
}
refreshLayerInsight();
}
function updateQuickReadout(){
 const box=$('#quickReadout');
 if(!['temperature','rainfall'].includes(active)){box.hidden=true;return;}
 box.hidden=false;
 const label={temperature:'TEMPERATURE',rainfall:'RAINFALL',drought:'DROUGHT / SPI'}[active];
 $('#qtitle').textContent=label;
 $('#qplace').textContent=point?point.name:'Search a location or click the map';
 const key=active==='temperature'?'temp':active==='rainfall'?'rain':null;
 const val=key?$('#'+key).textContent:'';
 $('#qvalue').textContent=active==='rainfall'?'RADAR MAP':(!point?'—':(active==='drought'?'SPI MAP':val||'Loading…'));
 $('#qsub').textContent=active==='temperature'?'2-metre air temperature at the selected point. Colored contour lines represent interpolated model temperatures, not observed ground temperatures.':active==='rainfall'?'Colored areas show RainViewer radar echoes across the region. The model estimate at the selected city is listed separately below; zero at one point does not mean the surrounding area is dry.':'Copernicus Global Drought Observatory standardized precipitation indicator. Regional layer; latest publication date not verified. This is not a drought impact alert.';
 $('#qsource').textContent=active==='rainfall'?'RADAR: RainViewer (timestamp above) · POINT MODEL: '+(point?($('#rain').textContent||'loading'):'select location')+' · '+($('#timeinfo').textContent||'time pending'):(active==='drought'?'MAP: COPERNICUS GDO SPI · NO VERIFIED OBSERVATION DATE':'SOURCE: Open-Meteo model · Point estimate, not a regional raster');
 syncWeatherMotion();
}
function refreshLayerInsight(){
 updateQuickReadout();
 const node=$('#layerinsight'); if(!node)return;
 const notes={
 overview:'Base map only. Climate overview aggregation remains to be built; select an indicator to inspect it.',
 temperature:'Open-Meteo regional forecast grid interpolated over the visible map. Location reading is a separate point estimate. Map is forecast 2-metre air temperature, not satellite land-surface temperature or measured anomalies.',
 rainfall:'RAIN RADAR: animated observed radar reflectivity from RainViewer (where available). Point precipitation below comes separately from Open-Meteo and may disagree in time, location and source. No radar color may mean missing coverage, not no rain.',
 drought:'Copernicus Global Drought Observatory SPI WMS layer, latest available publication. Select 1-month or 6-month SPI and use the dated monthly timeline. The historical comparison below is a separate five-year sample, NOT SPI and NOT an official severity rating.',
 floods:'REPORTED: GDACS + NASA flood reports. FORECAST: sampled Copernicus GloFAS model discharge via Open-Meteo, showing flow changes, not official flood warnings or mapped inundation.',
 fires:'NASA VIIRS thermal anomaly map (satellite detections, not confirmed wildfire boundaries) and separate NASA EONET reported wildfire events. Dates, sources, and missing coverage are indicated in the map controls.',
 satellite:'Copernicus Sentinel-2 true-color imagery when zoomed in; Esri imagery for wider views. Acquisition date not established by this map.'
 };
 node.textContent=(point?point.name+' — ':'SELECT A LOCATION — ')+(notes[active]||'');
}
async function events(category){status('LOADING NASA EONET '+category.toUpperCase()+'…');try{const r=await fetch('https://eonet.gsfc.nasa.gov/api/v3/events?category='+category+'&status=open&limit=300');if(!r.ok)throw Error(r.status);const d=await r.json();let n=0;for(const e of d.events||[]){const g=e.geometry?.at(-1);if(g?.type!=='Point')continue;const [lon,lat]=g.coordinates;const el=document.createElement('div');el.textContent=e.title;L.circleMarker([lat,lon],{radius:6,color:'#f6c43b',fillColor:category==='floods'?'#3d9fea':'#ed6944',fillOpacity:.9}).bindPopup(el).addTo(markers);n++;}status(n+' NASA EONET REPORTED OPEN '+category.toUpperCase()+' EVENTS · NOT COMPREHENSIVE DETECTIONS');}catch(e){status('NASA EONET UNAVAILABLE: '+e.message)}}
const iso=d=>d.toISOString().slice(0,10),mean=a=>a.reduce((x,y)=>x+y,0)/a.length,sum=a=>a.reduce((x,y)=>x+y,0),valid=a=>a.filter(v=>typeof v==='number'&&Number.isFinite(v));
async function comparison(lat,lon,token){const out=$('#climatecompare');out.textContent='CALCULATING 30-DAY CLIMATE COMPARISON…';try{const end=new Date();end.setUTCDate(end.getUTCDate()-7);const start=new Date(end);start.setUTCDate(start.getUTCDate()-29);const month=start.getUTCMonth(),day=start.getUTCDate(),endMonth=end.getUTCMonth(),endDay=end.getUTCDate();const urls=[];urls.push('https://archive-api.open-meteo.com/v1/archive?latitude='+lat+'&longitude='+lon+'&start_date='+iso(start)+'&end_date='+iso(end)+'&daily=temperature_2m_mean,precipitation_sum&timezone=UTC');for(let y=1991;y<=2020;y++){const st=new Date(Date.UTC(y,month,day)),en=new Date(Date.UTC(y,endMonth,endDay));if(en<st)en.setUTCFullYear(y+1);urls.push('https://archive-api.open-meteo.com/v1/archive?latitude='+lat+'&longitude='+lon+'&start_date='+iso(st)+'&end_date='+iso(en)+'&daily=temperature_2m_mean,precipitation_sum&timezone=UTC');}
// Historical baseline uses a representative five-year sample to keep API usage moderate; explicitly label it.
const sample=[1991,1998,2005,2012,2020].map(y=>urls[y-1991+1]);const responses=await Promise.all([urls[0],...sample].map(async u=>{const r=await fetch(u);if(!r.ok)throw Error('archive HTTP '+r.status);return (await r.json()).daily;}));if(token!==weatherRequest)return;const cur=responses[0],hist=responses.slice(1);const t=valid(cur.temperature_2m_mean),pr=valid(cur.precipitation_sum);const histT=hist.map(d=>mean(valid(d.temperature_2m_mean))).filter(Number.isFinite),histP=hist.map(d=>sum(valid(d.precipitation_sum))).filter(Number.isFinite);if(!t.length||!pr.length||!histT.length||!histP.length)throw Error('insufficient data');$('#datastatus').textContent='Open-Meteo historical model response received for selected point; baseline is only five sampled years, NOT a climate normal.';const td=mean(t)-mean(histT),p=sum(pr),p0=mean(histP),pct=p0?100*(p-p0)/p0:null;out.textContent='RECENT 30 DAYS ('+iso(start)+' TO '+iso(end)+')\nTemperature: '+mean(t).toFixed(1)+'°C · '+(td>=0?'+':'')+td.toFixed(1)+'°C vs sample\nRainfall: '+p.toFixed(0)+' mm · '+(pct===null?'N/A':(pct>=0?'+':'')+pct.toFixed(0)+'%')+' vs sample\nReference: same calendar period in 1991, 1998, 2005, 2012, 2020. Model-based sample, NOT a full 1991–2020 climatology or official drought classification.';if(active==='drought')status('LOCAL RAINFALL DEVIATION '+(pct===null?'N/A':pct.toFixed(0)+'%')+' VS FIVE-YEAR HISTORICAL SAMPLE · NOT A DROUGHT WARNING');}catch(e){if(token===weatherRequest)$('#datastatus').textContent='Historical point request failed; do not interpret missing data as normal conditions.';out.textContent='HISTORICAL COMPARISON UNAVAILABLE: '+e.message+' · CURRENT CONDITIONS MAY STILL WORK.';}}
async function selectPoint(lat,lon,name){point={lat,lon,name:name||'SELECTED COORDINATES'};const token=++weatherRequest;locationMarker.clearLayers();refreshLayerInsight();const chosenMarker=L.circleMarker([lat,lon],{radius:7,color:'#FFC14B',fillColor:'#0b1913',fillOpacity:1,weight:3}).addTo(locationMarker);chosenMarker.on('click',ev=>{L.DomEvent.stopPropagation(ev);clearLocationPin();});$('#clearLocationPin').hidden=false;$('#place').textContent=point.name;$('#coords').textContent=lat.toFixed(3)+'°, '+lon.toFixed(3)+'°';for(const s of ['temp','rain','wind','humidity'])$('#'+s).textContent='…';updateQuickReadout();comparison(lat,lon,token);try{const r=await fetch('https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+'&current=temperature_2m,precipitation,wind_speed_10m,relative_humidity_2m&timezone=auto');if(!r.ok)throw Error(r.status);const j=await r.json(),c=j.current;if(token!==weatherRequest)return;$('#temp').textContent=c.temperature_2m+'°C';$('#rain').textContent=c.precipitation+' mm';$('#wind').textContent=c.wind_speed_10m+' km/h';$('#humidity').textContent=c.relative_humidity_2m+'%';$('#datastatus').textContent='Current point weather from Open-Meteo; historical sample status is shown below.';$('#timeinfo').textContent='OPEN-METEO POINT MODEL · '+c.time+' · PRECIPITATION OVER '+(c.interval?Math.round(c.interval/60)+' MINUTES':'CURRENT MODEL INTERVAL')+' · NOT A CITYWIDE RADAR TOTAL';updateQuickReadout();}catch(e){if(token!==weatherRequest)return;$('#datastatus').textContent='Current point weather fetch failed.';$('#timeinfo').textContent='WEATHER REQUEST UNAVAILABLE: '+e.message;for(const s of ['temp','rain','wind','humidity'])$('#'+s).textContent='N/A';updateQuickReadout();}}


// TEMPERATURE MAP: sample a 7×5 regularly spaced grid of 2m air temperature
// from Open-Meteo, then interpolate within viewport. Animated frames are hourly
// model forecasts, NOT observed hourly temperatures or ENSO anomalies.
const tempCanvas=document.getElementById('temperatureCanvas');
const tempCtx=tempCanvas.getContext('2d',{alpha:true});
const tempControls=document.getElementById('temperatureControls');
const tempPlay=document.getElementById('tempPlay');
const tempSlider=document.getElementById('tempFrame');
const TEMP_COLS=7,TEMP_ROWS=5;
let tempSamples=null,tempHours=[],tempIndex=0,tempTimer=null,tempToken=0,tempDelay=null;
function temperatureStop(){if(tempTimer){clearInterval(tempTimer);tempTimer=null;}tempPlay.textContent='▶ PLAY';}
function temperatureClear(){tempToken++;temperatureStop();tempSamples=null;tempHours=[];tempCanvas.hidden=true;tempControls.hidden=true;tempCtx.clearRect(0,0,tempCanvas.width,tempCanvas.height);}
function tempColor(v){
  const stops=[[-10,[41,85,179]],[0,[74,156,223]],[10,[117,201,189]],[20,[244,207,102]],[30,[248,150,75]],[40,[225,73,56]],[48,[148,30,56]]];
  if(v<=stops[0][0])return stops[0][1];
  for(let k=1;k<stops.length;k++)if(v<=stops[k][0]){const a=stops[k-1],b=stops[k],t=(v-a[0])/(b[0]-a[0]);return a[1].map((n,i)=>Math.round(n+(b[1][i]-n)*t));}
  return stops.at(-1)[1];
}
function tempDraw(){
  if(active!=='temperature'||!tempSamples)return;
  const w=tempCanvas.clientWidth,h=tempCanvas.clientHeight;if(!w||!h)return;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  tempCanvas.width=Math.round(w*dpr);tempCanvas.height=Math.round(h*dpr);
  tempCtx.setTransform(dpr,0,0,dpr,0,0);tempCtx.clearRect(0,0,w,h);
  // Draw isotherms ONLY. No background tint: geographic detail stays visible.
  const values=tempSamples.map(p=>Number(p.hourly?.temperature_2m?.[tempIndex]));
  if(values.some(v=>!Number.isFinite(v)))return;
  const spacing=12,cols=Math.ceil(w/spacing)+1,rows=Math.ceil(h/spacing)+1;
  const grid=new Float32Array(cols*rows);
  function sample(x,y){
    const gx=Math.min(TEMP_COLS-1,Math.max(0,x/w*(TEMP_COLS-1))),gy=Math.min(TEMP_ROWS-1,Math.max(0,y/h*(TEMP_ROWS-1)));
    const i=Math.min(TEMP_COLS-2,Math.floor(gx)),j=Math.min(TEMP_ROWS-2,Math.floor(gy));
    const fx=gx-i,fy=gy-j,a=values[j*TEMP_COLS+i],b=values[j*TEMP_COLS+i+1],c=values[(j+1)*TEMP_COLS+i],d=values[(j+1)*TEMP_COLS+i+1];
    return (a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy;
  }
  for(let j=0;j<rows;j++)for(let i=0;i<cols;i++)grid[j*cols+i]=sample(Math.min(w,i*spacing),Math.min(h,j*spacing));
  const min=Math.min(...values),max=Math.max(...values);
  const step=max-min>26?5:max-min>12?3:2;
  const levels=[];for(let v=Math.ceil(min/step)*step;v<=max&&levels.length<18;v+=step)levels.push(v);
  const pos=(i,j)=>[Math.min(w,i*spacing),Math.min(h,j*spacing)];
  let labelCount=0;
  levels.forEach((level,li)=>{
    const rgb=tempColor(level);const col='rgb('+rgb.join(',')+')';
    tempCtx.strokeStyle=col;tempCtx.lineWidth=2.2;tempCtx.globalAlpha=.88;
    tempCtx.shadowColor='rgba(5,20,15,.65)';tempCtx.shadowBlur=2;
    tempCtx.beginPath();
    const segments=[];
    for(let j=0;j<rows-1;j++)for(let i=0;i<cols-1;i++){
      const pts=[pos(i,j),pos(i+1,j),pos(i+1,j+1),pos(i,j+1)];
      const v=[grid[j*cols+i],grid[j*cols+i+1],grid[(j+1)*cols+i+1],grid[(j+1)*cols+i]];
      const crossings=[];
      for(let k=0;k<4;k++){const k2=(k+1)%4;if((v[k]<level)!==(v[k2]<level)){
        const t=(level-v[k])/(v[k2]-v[k]);crossings.push([pts[k][0]+t*(pts[k2][0]-pts[k][0]),pts[k][1]+t*(pts[k2][1]-pts[k][1])]);
      }}
      if(crossings.length===2)segments.push([crossings[0],crossings[1]]);
      else if(crossings.length===4){segments.push([crossings[0],crossings[1]],[crossings[2],crossings[3]]);}
    }
    for(const [u,v] of segments){tempCtx.moveTo(u[0],u[1]);tempCtx.lineTo(v[0],v[1]);}
    tempCtx.stroke();tempCtx.shadowBlur=0;
    // Label contours sparingly, rather than covering the geographic map.
    if(segments.length>8&&li%2===0&&labelCount<7){
      const mid=segments[Math.floor(segments.length*.45)][0];
      if(mid[0]>45&&mid[0]<w-35&&mid[1]>115&&mid[1]<h-90){
        tempCtx.globalAlpha=1;tempCtx.fillStyle='rgba(8,25,20,.90)';tempCtx.fillRect(mid[0]-18,mid[1]-12,39,21);
        tempCtx.fillStyle=col;tempCtx.font='bold 12px Inter,Arial,sans-serif';tempCtx.fillText(level+'°C',mid[0]-15,mid[1]+3);
        labelCount++;
      }
    }
  });
  tempCtx.globalAlpha=1;tempCtx.shadowBlur=0;
  document.getElementById('tempTime').textContent=(tempHours[tempIndex]||'—').replace('T',' ')+' UTC';
  tempSlider.value=String(tempIndex);
}
function tempShow(i){if(!tempSamples)return;tempIndex=Math.max(0,Math.min(tempHours.length-1,i));tempDraw();}
async function loadTemperatureField(){
  if(active!=='temperature')return;
  temperatureStop();const token=++tempToken;tempControls.hidden=false;tempCanvas.hidden=true;
  tempPlay.disabled=true;document.getElementById('tempTime').textContent='Loading…';
  document.getElementById('tempExplanation').textContent='Retrieving regional grid from Open-Meteo…';
  // Fixed viewport sampling; reload after pan/zoom, not on each animation frame.
  const bounds=map.getBounds(),south=Math.max(-85,bounds.getSouth()),north=Math.min(85,bounds.getNorth());
  const west=bounds.getWest(),east=bounds.getEast();const lats=[],lons=[];
  for(let j=0;j<TEMP_ROWS;j++)for(let i=0;i<TEMP_COLS;i++){
    lats.push((north+(south-north)*j/(TEMP_ROWS-1)).toFixed(3));
    lons.push((((west+(east-west)*i/(TEMP_COLS-1)+540)%360)-180).toFixed(3));
  }
  try{
    const url='https://api.open-meteo.com/v1/forecast?latitude='+lats.join(',')+'&longitude='+lons.join(',')+'&hourly=temperature_2m&forecast_hours=6&timezone=UTC';
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),18000);
    let response;try{response=await fetch(url,{signal:controller.signal});}finally{clearTimeout(timeout)}
    if(!response.ok)throw Error('HTTP '+response.status);
    const data=await response.json();if(token!==tempToken||active!=='temperature')return;
    const samples=Array.isArray(data)?data:[data];
    if(samples.length!==lats.length||!samples.every(p=>p.hourly?.temperature_2m?.length>=2))throw Error('Incomplete forecast grid');
    tempSamples=samples;tempHours=samples[0].hourly.time;tempIndex=0;
    tempSlider.max=String(tempHours.length-1);tempPlay.disabled=false;tempCanvas.hidden=false;
    document.getElementById('tempExplanation').textContent='MODEL FORECAST · '+samples.length+' sampled locations · '+tempHours.length+' hourly frames. Colored contour lines show approximate isotherms; the map remains fully visible. Regional resolution is approximate.';
    status('TEMPERATURE MODEL GRID LOADED · '+samples.length+' LOCATIONS · '+tempHours.length+' FORECAST HOURS');tempShow(0);
  }catch(e){if(token!==tempToken)return;tempPlay.disabled=true;tempCanvas.hidden=true;document.getElementById('tempTime').textContent='Unavailable';document.getElementById('tempExplanation').textContent='Temperature map unavailable: '+e.message+'. Click UPDATE. Missing colors do not imply normal temperature.';status('TEMPERATURE GRID CONNECTION FAILED · '+e.message);}
}
tempPlay.onclick=()=>{
  if(tempTimer){temperatureStop();return;}
  if(!tempSamples||tempHours.length<2)return;
  if(tempIndex>=tempHours.length-1)tempShow(0);
  tempPlay.textContent='Ⅱ PAUSE';
  tempTimer=setInterval(()=>{if(active!=='temperature'){temperatureStop();return;}tempShow((tempIndex+1)%tempHours.length)},1300);
};
document.getElementById('tempLatest').onclick=()=>{temperatureStop();tempShow(0)};
document.getElementById('tempRefresh').onclick=()=>loadTemperatureField();
tempSlider.oninput=e=>{temperatureStop();tempShow(Number(e.target.value))};
map.on('moveend',()=>{if(active==='temperature'){clearTimeout(tempDelay);tempDelay=setTimeout(loadTemperatureField,450)}});
window.addEventListener('resize',()=>{if(active==='temperature'&&tempSamples)tempDraw()});

// Local weather effects are deliberately symbolic, NOT geographic weather rasters or radar.
const motionCanvas=document.getElementById('weatherMotion');
const motionCtx=motionCanvas.getContext('2d');
const motionLegend=document.getElementById('visualLegend');
const prefersReducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
let motionFrame=0,motionMode='',motionValue=NaN,motionCenter=null,motionStart=performance.now();
const droplets=Array.from({length:90},(_,i)=>({x:((i*71)%173)/173,y:((i*47)%157)/157,offset:i*1.47}));
function syncWeatherMotion(){
  const v=active==='temperature'?parseFloat($('#temp').textContent):active==='rainfall'?parseFloat($('#rain').textContent):NaN;
  motionMode='';
  motionValue=v;
  motionLegend.hidden=!motionMode;
  if(motionMode)motionLegend.textContent=active==='temperature'?'ILLUSTRATIVE TEMPERATURE HALO · POINT VALUE ONLY':'OBSERVED RADAR FRAMES · SEE TIMESTAMP';
  if(!motionFrame)motionFrame=requestAnimationFrame(renderWeatherMotion);
}
function renderWeatherMotion(t){
  motionFrame=0;
  const bounds=motionCanvas.getBoundingClientRect();
  const dpr=Math.min(window.devicePixelRatio||1,2);
  if(motionCanvas.width!==Math.round(bounds.width*dpr)||motionCanvas.height!==Math.round(bounds.height*dpr)){
    motionCanvas.width=Math.round(bounds.width*dpr);motionCanvas.height=Math.round(bounds.height*dpr);
  }
  motionCtx.setTransform(dpr,0,0,dpr,0,0);
  motionCtx.clearRect(0,0,bounds.width,bounds.height);
  if(!motionMode||!point||!bounds.width||!bounds.height)return;
  const p=map.latLngToContainerPoint([point.lat,point.lon]);
  const x=p.x,y=p.y;
  if(x< -190||x>bounds.width+190||y< -190||y>bounds.height+190)return;
  const animate=!prefersReducedMotion.matches;
  const phase=animate?t/1000:0;
  motionCtx.save();
  if(motionMode==='temperature'){
    const value=motionValue;
    const color=value>=30?'239,82,55':value>=20?'247,155,57':value>=10?'238,198,66':'78,164,233';
    const radius=92+(animate?8*Math.sin(phase*1.9):0);
    const g=motionCtx.createRadialGradient(x,y,9,x,y,radius);
    g.addColorStop(0,`rgba(${color},0.48)`);g.addColorStop(.4,`rgba(${color},0.22)`);g.addColorStop(1,`rgba(${color},0)`);
    motionCtx.fillStyle=g;motionCtx.beginPath();motionCtx.arc(x,y,radius,0,2*Math.PI);motionCtx.fill();
    motionCtx.strokeStyle=`rgba(${color},0.7)`;motionCtx.lineWidth=2;
    motionCtx.beginPath();motionCtx.arc(x,y,64+(animate?5*Math.sin(phase*1.9):0),0,Math.PI*2);motionCtx.stroke();
  }else{
    // No rainfall observation -> no falling droplets; an outlined point is still selected on the map.
    if(motionValue>0){
      const strength=Math.min(1,0.25+Math.log1p(motionValue)*0.6);
      const radius=110;
      const g=motionCtx.createRadialGradient(x,y,0,x,y,radius);
      g.addColorStop(0,'rgba(37,148,232,0.20)');g.addColorStop(1,'rgba(37,148,232,0)');
      motionCtx.fillStyle=g;motionCtx.beginPath();motionCtx.arc(x,y,radius,0,2*Math.PI);motionCtx.fill();
      motionCtx.save();motionCtx.beginPath();motionCtx.arc(x,y,radius,0,2*Math.PI);motionCtx.clip();
      const count=Math.round(16+strength*62);
      motionCtx.strokeStyle=`rgba(170,224,255,${0.40+0.42*strength})`;
      motionCtx.lineWidth=1.5;
      for(let i=0;i<count;i++){
        const d=droplets[i]; const xx=x+(d.x-.5)*220;
        const yy=y+(((d.y+(animate?phase*(.48+strength*.5):0)+d.offset)%1)-.5)*220;
        motionCtx.beginPath();motionCtx.moveTo(xx,yy);motionCtx.lineTo(xx-3,yy+9+strength*9);motionCtx.stroke();
      }
      motionCtx.restore();
    }
  }
  motionCtx.restore();
  if(animate)motionFrame=requestAnimationFrame(renderWeatherMotion);
}
map.on('moveend zoomend resize',()=>{if(motionMode&&!motionFrame)motionFrame=requestAnimationFrame(renderWeatherMotion);});


// Flood map inspection: never implies an unverified forecast is absent, and never leaves a pin.
async function inspectFloodPoint(latlng){
 if(active!=='floods')return;
 const lat=latlng.lat.toFixed(3),lon=latlng.lng.toFixed(3);
 const popup=L.popup({autoClose:true,closeButton:true,maxWidth:310}).setLatLng(latlng).setContent('<strong>FLOOD INFORMATION</strong><p>Checking place name…</p>').openOn(map);
 let place=lat+'°, '+lon+'°';
 try{
  const r=await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat='+encodeURIComponent(lat)+'&lon='+encodeURIComponent(lon)+'&zoom=10&addressdetails=1&accept-language=en',{headers:{'Accept-Language':'en'}});
  if(r.ok){const j=await r.json();const a=j.address||{};place=[a.city||a.town||a.village||a.county||a.state,a.country].filter(Boolean).join(', ')||place;}
 }catch(e){}
 if(active!=='floods'||!map.hasLayer(popup))return;
 const content=document.createElement('div');
 const h=document.createElement('strong');h.textContent=place;content.append(h);
 const p=document.createElement('p');p.textContent=floodMode==='reported'?'This map shows reported NASA flood-event locations. No marker here does not mean no flooding.': 'Nearby modeled river-discharge forecast samples are indicated by colored circles. Click a circle for values. No official local flood-risk threshold is available at this clicked point.';content.append(p);
 const sub=document.createElement('small');sub.textContent='SELECT REPORTED / 1–3 DAYS / 4–10 DAYS ABOVE · NO PIN PLACED';content.append(sub);
 popup.setContent(content);
}

function clearLocationPin(){
 weatherRequest++;point=null;locationMarker.clearLayers();$('#clearLocationPin').hidden=true;$('#search').value='';
 $('#place').textContent='SELECT A LOCATION';$('#coords').textContent='Choose a location or search above';
 for(const id of ['temp','rain','wind','humidity'])$('#'+id).textContent='—';
 $('#timeinfo').textContent='No location selected.';$('#climatecompare').textContent='Select a location to see its climate comparison.';
 updateQuickReadout();refreshLayerInsight();
 status('LOCATION PIN CLEARED · MAP AND FLOOD LAYERS UNCHANGED');
}
$('#clearLocationPin').onclick=clearLocationPin;
map.on('click',e=>{
 // In flood/event/global modes a map click should never leave an unwanted dot.
 if(active==='floods'){inspectFloodPoint(e.latlng);return;}if(['fires','overview'].includes(active))return;
 selectPoint(e.latlng.lat,e.latlng.lng);
});document.querySelectorAll('[data-layer]').forEach(b=>b.onclick=()=>setLayer(b.dataset.layer));const regions={amazon:[-5,-63,5],pacific:[0,-125,3],africa:[0,36,5],asia:[3,115,5],world:[10,0,2]};document.querySelectorAll('[data-region]').forEach(b=>b.onclick=()=>map.setView(regions[b.dataset.region].slice(0,2),regions[b.dataset.region][2]));$('#search').addEventListener('keydown',async e=>{if(e.key!=='Enter')return;const q=e.target.value.trim();if(!q)return;status('SEARCHING '+q+'…');try{const r=await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q='+encodeURIComponent(q));if(!r.ok)throw Error(r.status);const d=await r.json();if(!d.length)throw Error('No location found');const lat=+d[0].lat,lon=+d[0].lon;map.setView([lat,lon],8);selectPoint(lat,lon,d[0].display_name.split(',').slice(0,2).join(','));status('LOCATION FOUND · '+names[active]);}catch(err){status('SEARCH UNAVAILABLE: '+err.message)}});
// Region shortcuts keep the active climate layer and current time selection.
const gcmRegionBounds={
 latin:[[-58,-102],[26,-30]],
 africa:[[-36,-19],[38,52]],
 southeast:[[-12,91],[24,142]]
};
const gcmRegionLabels={latin:'LATIN AMERICA',africa:'AFRICA',southeast:'SOUTHEAST ASIA'};
document.querySelectorAll('[data-region-preset]').forEach(button=>button.addEventListener('click',()=>{
 const key=button.dataset.regionPreset;
 const bounds=gcmRegionBounds[key];if(!bounds)return;
 // Clear a previously searched point so the side panel does not describe the wrong region.
 if(point)clearLocationPin();
 document.querySelectorAll('[data-region-preset]').forEach(b=>b.classList.toggle('selected',b===button));
 if(key==='latin'){
   // Reference framing: Mexico and Central America across the upper left,
   // all of South America through Patagonia, and no African coastline.
   // A fractional zoom avoids the huge jump between Leaflet's integer levels.
   map.setView([-12,-79],4.2,{animate:false});
   // Keep the eastern edge firmly west of Africa on wide desktop layouts.
   // Pan rather than zoom farther in: otherwise Patagonia gets clipped.
   const eastLimit=-21;
   const east=map.getBounds().getEast();
   if(east>eastLimit){
     const p0=map.project(map.getCenter(),map.getZoom());
     const worldPixels=256*Math.pow(2,map.getZoom());
     const excessPx=(east-eastLimit)/360*worldPixels;
     const shifted=map.unproject(L.point(p0.x-excessPx-8,p0.y),map.getZoom());
     map.panTo(shifted,{animate:false});
   }
 }else{
   map.fitBounds(bounds,{padding:[18,18],maxZoom:5,animate:false});
 }
 $('#maplabel').textContent=gcmRegionLabels[key]+' / '+names[active];
 status(gcmRegionLabels[key]+' · '+names[active]+' · SELECT A LOCATION OR CLIMATE LAYER');
}));
document.querySelectorAll('[data-layer]').forEach(button=>button.addEventListener('click',()=>{
 document.querySelectorAll('[data-region-preset]').forEach(b=>b.classList.remove('selected'));
}));

setLayer('overview');
