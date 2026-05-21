/* ═══════════════════════════════════════════════════
   PlotIQ — app.js
   Smart City Property Registry
   All features: Draw, Structure Editor, Verify,
   Delete, Availability, Search, Filter, API + Offline
═══════════════════════════════════════════════════ */

// ═══════════════════════════════════════
// STATE VARIABLES
// ═══════════════════════════════════════
let mode          = 'draw';
let drawPoints    = [];
let polygonClosed = false;
let locationSet   = false;
let currentPolygon  = null;
let currentPolyline = null;
let firstDot        = null;
let dotMarkers      = [];
let roomLabels      = [];
let roomMarkers     = [];
let selectedRoom    = null;
let savedHouses     = [];
let structureData   = null;
let activeFilter    = 'all';
let searchMarker    = null;
let plotLayer       = null;
let savedPolygons   = {};

// ── API base URL — change if server is on different port ──
const API = 'http://localhost:3000/api';

// ── Room definitions ──
const ROOM_DEFS = [
  { name: 'Master Bed', color: '#3b82f6' },
  { name: 'Bedroom',    color: '#8b5cf6' },
  { name: 'Kitchen',    color: '#f59e0b' },
  { name: 'Hall',       color: '#10b981' },
  { name: 'Bathroom',   color: '#06b6d4' },
  { name: 'Lounge',     color: '#ec4899' },
  { name: 'Veranda',    color: '#d97706' },
  { name: 'Store',      color: '#6b7280' },
  { name: 'Garage',     color: '#78716c' },
  { name: 'Garden',     color: '#16a34a' },
];
let roomDefs = ROOM_DEFS.map(r => ({ ...r, placed: false }));

// ── Availability config ──
const AVAIL = {
  available:          { color: '#16a34a', fill: '#dcfce7', label: 'For Sale',           icon: '🟢' },
  for_rent:           { color: '#0ea5e9', fill: '#e0f2fe', label: 'For Rent',           icon: '🔵' },
  occupied:           { color: '#dc2626', fill: '#fee2e2', label: 'Occupied',           icon: '🔴' },
  under_construction: { color: '#d97706', fill: '#fef3c7', label: 'Under Construction', icon: '🟡' },
  rented:             { color: '#7c3aed', fill: '#ede9fe', label: 'Rented Out',         icon: '🟣' },
};
function getAV(h) { return AVAIL[h.availability] || AVAIL.available; }

// ═══════════════════════════════════════
// MAP INITIALISATION
// ═══════════════════════════════════════
const map = L.map('map', { zoomControl: true }).setView([33.7294, 73.0931], 14);

const cartoTile = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  { attribution: '© CARTO © OpenStreetMap', maxZoom: 22, subdomains: 'abcd' }
);
const osmTile = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { attribution: '© OpenStreetMap', maxZoom: 22 }
);
cartoTile.addTo(map);
L.control.layers({ 'Carto Light': cartoTile, 'OpenStreetMap': osmTile }, {}, { position: 'topright', collapsed: true }).addTo(map);
setTimeout(() => map.invalidateSize(), 200);

map.on('click', e => {
  if (mode === 'draw' && !polygonClosed) addPoint(e.latlng);
  else if (mode === 'room' && polygonClosed) {
    if (selectedRoom) placeRoomLabel(e.latlng);
    else toast('Select a room type from the panel first', 2200);
  }
});

// ═══════════════════════════════════════
// LOCATION SEARCH (Nominatim API)
// ═══════════════════════════════════════
async function searchLocation() {
  const query = document.getElementById('location-search').value.trim();
  if (!query) { toast('Please type a location first', 2000); return; }

  const box = document.getElementById('search-results-list');
  box.style.display = 'block';
  box.innerHTML = `<div class="result-item"><span class="result-name" style="color:var(--muted)">Searching...</span></div>`;

  try {
    const res  = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    if (!data.length) {
      box.innerHTML = `<div class="result-item"><span class="result-name" style="color:#f87171">No results found. Try a more specific address.</span></div>`;
      return;
    }
    box.innerHTML = data.map(item => {
      const parts = item.display_name.split(',');
      return `<div class="result-item" onclick="selectLocation(${item.lat}, ${item.lon}, \`${item.display_name.replace(/`/g,"'")}\`)">
        <span class="result-name">${parts[0].trim()}</span>
        <span class="result-sub">${parts.slice(1, 3).join(',').trim()}</span>
      </div>`;
    }).join('');
  } catch (err) {
    box.innerHTML = `<div class="result-item"><span class="result-name" style="color:#f87171">Connection error. Check internet.</span></div>`;
  }
}

function selectLocation(lat, lon, displayName) {
  lat = parseFloat(lat); lon = parseFloat(lon);
  if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
  map.flyTo([lat, lon], 19, { duration: 1.8 });
  searchMarker = L.marker([lat, lon], {
    icon: L.divIcon({
      html: `<div style="background:#dc2626;width:14px;height:14px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.4)"></div>`,
      className: '', iconAnchor: [7, 7]
    })
  }).addTo(map).bindTooltip(displayName.split(',')[0], { permanent: true, direction: 'top' });

  document.getElementById('f-address').value             = displayName.split(',').slice(0, 3).join(',').trim();
  document.getElementById('search-results-list').style.display = 'none';
  document.getElementById('location-confirmed').style.display  = 'block';
  locationSet = true;
  updateSteps();
  toast('Location found! Zoom in to see plot boundaries in orange', 3500);
  setTimeout(() => loadPlotBoundaries(lat, lon), 2000);
}

// ═══════════════════════════════════════
// PLOT BOUNDARIES (Overpass API)
// ═══════════════════════════════════════
async function loadPlotBoundaries(lat, lon) {
  if (plotLayer) { map.removeLayer(plotLayer); plotLayer = null; }
  toast('Loading plot outlines...', 2000);
  const query = `[out:json][timeout:15];(way["building"](around:150,${lat},${lon});way["landuse"~"residential|plot"](around:150,${lat},${lon}););out body;>;out skel qt;`;
  try {
    const res  = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(query) });
    const data = await res.json();
    if (!data.elements?.length) { toast('No plot data found. Draw your boundary manually.', 3000); return; }
    const nodes = {};
    data.elements.filter(e => e.type === 'node').forEach(n => { nodes[n.id] = [n.lat, n.lon]; });
    const layers = [];
    data.elements.filter(e => e.type === 'way' && e.nodes).forEach(way => {
      const coords = way.nodes.map(id => nodes[id]).filter(Boolean);
      if (coords.length < 3) return;
      layers.push(L.polygon(coords, { color: '#f97316', fillColor: '#fed7aa', fillOpacity: 0.2, weight: 2, dashArray: '5 3' })
        .bindTooltip('This is one plot — draw inside yours', { sticky: true, direction: 'top' }));
    });
    if (layers.length) {
      plotLayer = L.layerGroup(layers).addTo(map);
      toast(`${layers.length} plot outlines shown in orange`, 3000);
    }
  } catch (err) { toast('Plot data unavailable. Draw boundary manually.', 2500); }
}

// ═══════════════════════════════════════
// DRAW BOUNDARY
// ═══════════════════════════════════════
function addPoint(latlng) {
  if (!locationSet) { toast('Search your location first', 2500); return; }
  if (drawPoints.length >= 3 && map.distance(latlng, drawPoints[0]) < 8) { finishPolygon(); return; }

  drawPoints.push(latlng);
  updateSteps(); updateCoords(); redrawLine();

  // ── Live area calculation after every point ──
  if (drawPoints.length >= 3) updateLiveArea();

  if (drawPoints.length === 1) {
    firstDot = L.circleMarker(latlng, { radius: 8, color: '#1a56db', fillColor: '#93c5fd', fillOpacity: 1, weight: 2 }).addTo(map);
  } else {
    dotMarkers.push(L.circleMarker(latlng, { radius: 5, color: '#1a56db', fillColor: '#fff', fillOpacity: 1, weight: 2 }).addTo(map));
  }
  if (drawPoints.length >= 3 && firstDot) {
    firstDot.setStyle({ radius: 10, color: '#059669', fillColor: '#86efac' });
    firstDot.bindTooltip('Click here to close shape', { permanent: true, direction: 'top' });
    document.getElementById('btn-save-house').disabled = false;
  }
}

function redrawLine() {
  if (currentPolyline) map.removeLayer(currentPolyline);
  if (drawPoints.length < 2) return;
  currentPolyline = L.polyline(drawPoints, { color: '#1a56db', weight: 2, dashArray: '6 4', opacity: 0.8 }).addTo(map);
}

function finishPolygon() {
  if (drawPoints.length < 3) { toast('Need at least 3 points', 2000); return; }
  dotMarkers.forEach(d => map.removeLayer(d)); dotMarkers = [];
  if (firstDot)        { map.removeLayer(firstDot);        firstDot        = null; }
  if (currentPolyline) { map.removeLayer(currentPolyline); currentPolyline = null; }

  currentPolygon = L.polygon(drawPoints, { color: '#1a56db', fillColor: '#dbeafe', fillOpacity: 0.4, weight: 2 }).addTo(map);
  polygonClosed  = true;
  updateLiveArea(true);   // lock in final measurement and turn green
  updateSteps();
  document.getElementById('btn-open-struct').disabled = false;
  document.getElementById('struct-preview-area').style.display = 'block';
  map.fitBounds(currentPolygon.getBounds(), { padding: [60, 60] });
  toast('Boundary closed! Now click Draw House Structure', 3000);
}

function undoPoint() {
  if (!drawPoints.length) return;
  drawPoints.pop();
  if (!drawPoints.length && firstDot) { map.removeLayer(firstDot); firstDot = null; }
  else if (dotMarkers.length) { map.removeLayer(dotMarkers.pop()); }
  redrawLine(); updateCoords(); updateSteps();
  if (drawPoints.length < 3) document.getElementById('btn-save-house').disabled = true;
  // Update or hide live area after undo
  if (drawPoints.length >= 3) updateLiveArea();
  else hideLiveArea();
}

function clearAll(silent = false) {
  drawPoints = []; polygonClosed = false; selectedRoom = null; structureData = null;
  [currentPolygon, currentPolyline, firstDot, searchMarker, plotLayer].forEach(l => { if (l) map.removeLayer(l); });
  currentPolygon = currentPolyline = firstDot = searchMarker = plotLayer = null;
  dotMarkers.forEach(d => map.removeLayer(d));   dotMarkers  = [];
  roomMarkers.forEach(m => map.removeLayer(m));  roomMarkers = [];
  roomLabels = [];
  roomDefs.forEach(r => r.placed = false);
  locationSet = false;
  ['location-confirmed', 'search-results-list', 'struct-preview-area'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.getElementById('location-search').value    = '';
  document.getElementById('btn-open-struct').disabled = true;
  document.getElementById('btn-save-house').disabled  = true;
  updateCoords(); updateSteps(); renderRoomGrid(); clearCanvas(); hideLiveArea();
  if (!silent) toast('Cleared', 1500);
}

function clearRooms() {
  roomMarkers.forEach(m => map.removeLayer(m));
  roomMarkers = []; roomLabels = [];
  roomDefs.forEach(r => r.placed = false);
  selectedRoom = null; renderRoomGrid();
  toast('Room labels cleared', 1500);
}

// ═══════════════════════════════════════
// ROOM LABELS ON MAP
// ═══════════════════════════════════════
function renderRoomGrid() {
  document.getElementById('room-grid').innerHTML = roomDefs.map(r => `
    <div class="room-chip ${r.placed ? 'placed' : ''} ${selectedRoom === r.name ? 'selected' : ''}"
         onclick="selectRoom('${r.name}')"
         style="${selectedRoom === r.name ? `border-color:${r.color};background:${r.color}18` : ''}">
      <div class="rchip-dot" style="background:${r.color}"></div>
      <div class="rchip-name">${r.name}</div>
      <div class="rchip-status">${r.placed ? '✓ Placed' : 'Click to select'}</div>
    </div>`).join('');
}

function selectRoom(name) {
  if (!polygonClosed) { toast('Close the boundary first', 2000); return; }
  selectedRoom = selectedRoom === name ? null : name;
  renderRoomGrid();
  if (selectedRoom) toast(`Click inside the house to place "${name}"`, 2200);
}

function addCustomRoom() {
  const inp  = document.getElementById('custom-room');
  const name = inp.value.trim(); if (!name) return;
  const colors = ['#f43f5e','#f97316','#eab308','#84cc16','#06b6d4','#a855f7'];
  roomDefs.push({ name, color: colors[roomDefs.length % colors.length], placed: false });
  inp.value = ''; renderRoomGrid();
}

function placeRoomLabel(latlng) {
  const r = roomDefs.find(x => x.name === selectedRoom); if (!r) return;
  if (currentPolygon && !ptInPoly(latlng, drawPoints)) { toast('Place label inside the boundary', 2000); return; }
  const ex = roomLabels.find(l => l.name === selectedRoom);
  if (ex) { map.removeLayer(ex.marker); roomLabels = roomLabels.filter(l => l.name !== selectedRoom); }
  const icon = L.divIcon({
    html: `<div style="background:${r.color};color:#fff;padding:4px 10px;border-radius:6px;font-family:'Outfit',sans-serif;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.25);border:2px solid rgba(255,255,255,0.4)">${r.name}</div>`,
    className: '', iconAnchor: [0, 0]
  });
  const marker = L.marker(latlng, { icon, draggable: true }).addTo(map);
  roomLabels.push({ name: r.name, color: r.color, marker, lat: latlng.lat, lng: latlng.lng });
  roomMarkers.push(marker);
  r.placed = true; selectedRoom = null;
  renderRoomGrid(); toast(`"${r.name}" placed`, 1500);
}

function ptInPoly(pt, poly) {
  let inside = false;
  const x = pt.lat, y = pt.lng;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lat, yi = poly[i].lng, xj = poly[j].lat, yj = poly[j].lng;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// ═══════════════════════════════════════
// STRUCTURE EDITOR CANVAS
// ═══════════════════════════════════════
const canvas = document.getElementById('struct-canvas');
const ctx    = canvas.getContext('2d');
let drawMode         = 'room';
let selectedRoomType = roomDefs[0];
let structRooms      = [];
let structWalls      = [];
let structHistory    = [];
let isDrawingRoom    = false;
let roomStart        = { x: 0, y: 0 };
const GRID           = 20;

function openStructureEditor() {
  if (!polygonClosed) { toast('Draw and close your plot boundary first', 2000); return; }
  document.getElementById('struct-overlay').classList.add('open');
  const owner = document.getElementById('f-owner').value || 'Unknown';
  const addr  = document.getElementById('f-address').value || '';
  document.getElementById('popup-subtitle').textContent = `${owner} — ${addr}`;
  setTimeout(() => { resizeCanvas(); renderDrawRoomList(); renderLegend(); redrawCanvas(); }, 90);
}

function closeStructureEditor() { document.getElementById('struct-overlay').classList.remove('open'); }

function resizeCanvas() {
  const area = document.querySelector('.canvas-wrap');
  canvas.style.width  = area.clientWidth  + 'px';
  canvas.style.height = area.clientHeight + 'px';
  canvas.width  = area.clientWidth;
  canvas.height = area.clientHeight;
  drawGrid();
}

window.addEventListener('resize', () => {
  if (document.getElementById('struct-overlay').classList.contains('open')) { resizeCanvas(); redrawCanvas(); }
});

function getCP(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
}
function snap(v) { return Math.round(v / GRID) * GRID; }

function drawGrid() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1e1e1e'; ctx.lineWidth = 0.5;
  for (let x = 0; x < canvas.width;  x += GRID) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
  for (let y = 0; y < canvas.height; y += GRID) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y);  ctx.stroke(); }
  ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width;  x += GRID*5) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
  for (let y = 0; y < canvas.height; y += GRID*5) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y);  ctx.stroke(); }
}

function redrawCanvas() {
  drawGrid();
  structRooms.forEach(r => {
    ctx.fillStyle   = hexRgba(r.color, 0.22);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = r.color; ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = r.color; ctx.font = 'bold 12px Outfit,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(r.name, r.x + r.w / 2, r.y + r.h / 2);
  });
  structWalls.forEach(w => {
    ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(w.x1, w.y1); ctx.lineTo(w.x2, w.y2); ctx.stroke();
  });
  document.getElementById('rooms-placed-count').textContent = structRooms.length;
}

function hexRgba(hex, a) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

canvas.addEventListener('mousedown', e => {
  e.preventDefault();
  const pos = getCP(e);
  if (drawMode === 'room') {
    roomStart = { x: snap(pos.x), y: snap(pos.y) }; isDrawingRoom = true;
  } else if (drawMode === 'wall') {
    const sx = snap(pos.x), sy = snap(pos.y);
    canvas.addEventListener('mouseup', function we(e2) {
      e2.preventDefault();
      const p2 = getCP(e2);
      const ex = snap(p2.x), ey = snap(p2.y);
      if (Math.abs(ex-sx)>5 || Math.abs(ey-sy)>5) {
        pushHistory(); structWalls.push({ x1:sx, y1:sy, x2:ex, y2:ey });
        redrawCanvas(); toast('Wall added', 1200);
      }
      canvas.removeEventListener('mouseup', we);
    });
  } else if (drawMode === 'erase') {
    pushHistory();
    const before = structRooms.length;
    structRooms = structRooms.filter(r => !(pos.x>=r.x && pos.x<=r.x+r.w && pos.y>=r.y && pos.y<=r.y+r.h));
    if (structRooms.length < before) toast('Room erased', 1200);
    redrawCanvas();
  }
});

canvas.addEventListener('mousemove', e => {
  if (!isDrawingRoom) return;
  e.preventDefault();
  const pos = getCP(e);
  const mx = snap(pos.x), my = snap(pos.y);
  redrawCanvas();
  const rw = mx - roomStart.x, rh = my - roomStart.y;
  if (Math.abs(rw) >= GRID && Math.abs(rh) >= GRID) {
    const rx = Math.min(roomStart.x,mx), ry = Math.min(roomStart.y,my);
    const aw = Math.abs(rw), ah = Math.abs(rh);
    ctx.fillStyle   = hexRgba(selectedRoomType.color, 0.15);
    ctx.fillRect(rx, ry, aw, ah);
    ctx.strokeStyle = selectedRoomType.color; ctx.lineWidth = 2;
    ctx.setLineDash([6,3]); ctx.strokeRect(rx, ry, aw, ah); ctx.setLineDash([]);
    ctx.fillStyle = selectedRoomType.color; ctx.font = 'bold 12px Outfit,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(selectedRoomType.name, rx+aw/2, ry+ah/2);
    document.getElementById('footer-hint').textContent = `Drawing "${selectedRoomType.name}" — release to place`;
  }
});

canvas.addEventListener('mouseup', e => {
  if (!isDrawingRoom) return;
  e.preventDefault(); isDrawingRoom = false;
  const pos = getCP(e);
  const ex = snap(pos.x), ey = snap(pos.y);
  const x = Math.min(roomStart.x,ex), y = Math.min(roomStart.y,ey);
  const w = Math.abs(ex-roomStart.x), h = Math.abs(ey-roomStart.y);
  if (w >= GRID && h >= GRID) {
    pushHistory();
    structRooms.push({ x, y, w, h, name: selectedRoomType.name, color: selectedRoomType.color });
    redrawCanvas(); renderDrawRoomList();
    toast(`"${selectedRoomType.name}" drawn!`, 1500);
    document.getElementById('footer-hint').textContent = `"${selectedRoomType.name}" added. Select another room to continue.`;
  } else {
    redrawCanvas();
    document.getElementById('footer-hint').textContent = 'Too small — hold and drag further before releasing.';
  }
});

canvas.addEventListener('mouseleave', () => { if (isDrawingRoom) { isDrawingRoom = false; redrawCanvas(); } });

function pushHistory() { structHistory.push(JSON.parse(JSON.stringify({ rooms: structRooms, walls: structWalls }))); }

function setDrawMode(m) {
  drawMode = m;
  document.querySelectorAll('.dmode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('dmode-' + m).classList.add('active');
  document.getElementById('mode-display').textContent = { room:'Draw Room', wall:'Draw Wall', erase:'Erase' }[m];
  canvas.style.cursor = m === 'erase' ? 'not-allowed' : 'crosshair';
}

function renderDrawRoomList() {
  document.getElementById('draw-room-list').innerHTML = roomDefs.map(r => `
    <div class="dr-item ${selectedRoomType?.name===r.name?'selected':''} ${structRooms.some(s=>s.name===r.name)?'placed':''}"
         onclick="selectDrawRoom('${r.name}')">
      <div class="dr-dot" style="background:${r.color}"></div>
      <div class="dr-name">${r.name}</div>
      ${structRooms.some(s=>s.name===r.name)?'<span class="dr-check">✓</span>':''}
    </div>`).join('');
}

function selectDrawRoom(name) {
  selectedRoomType = roomDefs.find(r => r.name === name) || roomDefs[0];
  setDrawMode('room'); renderDrawRoomList();
}

function renderLegend() {
  document.getElementById('canvas-legend').innerHTML = roomDefs.slice(0,6).map(r => `
    <div class="legend-row">
      <div class="legend-swatch" style="background:${hexRgba(r.color,0.3)};border:1px solid ${r.color}"></div>
      <span>${r.name}</span>
    </div>`).join('');
}

function undoStruct() {
  if (!structHistory.length) { toast('Nothing to undo', 1500); return; }
  const p = structHistory.pop(); structRooms = [...p.rooms]; structWalls = [...p.walls];
  redrawCanvas(); renderDrawRoomList();
}

function clearCanvas() {
  pushHistory(); structRooms = []; structWalls = [];
  redrawCanvas(); renderDrawRoomList();
}

function saveStructure() {
  if (!structRooms.length && !structWalls.length) { toast('Draw at least one room first', 2000); return; }
  structureData = { rooms: [...structRooms], walls: [...structWalls], canvasW: canvas.width, canvasH: canvas.height };
  drawMiniPreview();
  document.getElementById('struct-status-text').textContent = `${structRooms.length} room${structRooms.length!==1?'s':''} drawn`;
  closeStructureEditor();
  toast('Structure saved! Fill in details and click Save House.', 3000);
}

function drawMiniPreview() {
  if (!structureData) return;
  const mc  = document.getElementById('mini-preview');
  const mx  = mc.getContext('2d');
  const sc  = Math.min(mc.width/structureData.canvasW, mc.height/structureData.canvasH) * 0.9;
  const ox  = (mc.width  - structureData.canvasW*sc) / 2;
  const oy  = (mc.height - structureData.canvasH*sc) / 2;
  mx.clearRect(0,0,mc.width,mc.height);
  mx.fillStyle = '#111'; mx.fillRect(0,0,mc.width,mc.height);
  structureData.rooms.forEach(r => {
    mx.fillStyle   = hexRgba(r.color,0.28); mx.fillRect(ox+r.x*sc, oy+r.y*sc, r.w*sc, r.h*sc);
    mx.strokeStyle = r.color; mx.lineWidth = 1;
    mx.strokeRect(ox+r.x*sc, oy+r.y*sc, r.w*sc, r.h*sc);
    mx.fillStyle = r.color; mx.font = `${Math.max(7,8*sc)}px Outfit,sans-serif`;
    mx.textAlign = 'center'; mx.textBaseline = 'middle';
    mx.fillText(r.name, ox+(r.x+r.w/2)*sc, oy+(r.y+r.h/2)*sc);
  });
}

// ═══════════════════════════════════════
// SAVE HOUSE
// ═══════════════════════════════════════
async function saveHouse() {
  if (!polygonClosed) { toast('Close the boundary first', 2000); return; }
  const ownerRaw = document.getElementById('f-owner').value.trim();
  if (!ownerRaw) {
    toast('Please enter the Owner Name before saving', 3000);
    document.getElementById('f-owner').focus();
    document.getElementById('btn-save-house').disabled = false;
    document.getElementById('btn-save-house').textContent = 'Save House';
    return;
  }
  const owner = ownerRaw;
  const address      = document.getElementById('f-address').value.trim() || 'No address';
  const type         = document.getElementById('f-type').value;
  const area         = document.getElementById('f-area').value;
  const price        = document.getElementById('f-price').value;
  const year         = document.getElementById('f-year').value;
  const availability = document.getElementById('f-availability').value;

  const btn = document.getElementById('btn-save-house');
  btn.disabled = true; btn.textContent = 'Saving...';

  const payload = {
    owner, address, type, area, price, year, availability,
    points:    drawPoints.map(p => ({ lat: p.lat, lng: p.lng })),
    rooms:     roomLabels.map(l => ({ name: l.name, color: l.color, lat: l.lat, lng: l.lng })),
    structure: structureData   
  };

  try {
    const res  = await fetch(`${API}/houses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      toast(`"${owner}" saved to database!`, 3000);
      clearAll(true); await loadHousesFromDB(); switchTab('saved');
    } else {
      toast('Error: ' + (data.error || 'Unknown error'), 4000);
      btn.disabled = false; btn.textContent = 'Save House';
    }
  } catch (err) {
    // Offline fallback — save to localStorage
    const house = {
      id: Date.now(), owner, address, type, area, price, year, availability,
      status: 'Saved', isVerified: false, savedDate: new Date().toLocaleDateString(),
      points: drawPoints.map(p => ({ lat: p.lat, lng: p.lng })),
      rooms:  roomLabels.map(l => ({ name: l.name, color: l.color, lat: l.lat, lng: l.lng })),
      structure: structureData
    };
    savedHouses.push(house);
    localStorage.setItem('piq_houses', JSON.stringify(savedHouses));
    plotSavedHouse(house); updateStats(); renderSavedList();
    clearAll(true);
    toast('Saved offline (server not reachable)', 3000);
    switchTab('saved');
  }
}

// ═══════════════════════════════════════
// PLOT SAVED HOUSE ON MAP
// ═══════════════════════════════════════
function plotSavedHouse(h) {
  if (!h.points || h.points.length < 3) return;
  const av   = getAV(h);
  const poly = L.polygon(h.points.map(p => [p.lat, p.lng]), {
    color: av.color, fillColor: av.fill, fillOpacity: 0.4, weight: 2.5
  }).addTo(map);
  savedPolygons[h.id] = poly;

  const roomsHTML = (h.rooms || []).map(r =>
    `<span class="ctag" style="background:${r.color}22;color:${r.color}">${r.name}</span>`
  ).join('');

  const structRoomCount = h.structure && h.structure.rooms ? h.structure.rooms.length : 0;
  const structBtn = (h.structure && structRoomCount > 0)
    ? `<button class="map-popup-struct-btn" onclick="previewStructure(${h.id})">
        View House Structure (${structRoomCount} rooms)
       </button>` : '';

  poly.bindPopup(`
    <div class="map-popup-name">${h.owner}</div>
    <div class="map-popup-addr">${h.address}</div>
    <div class="avail-badge avail-${h.availability||'available'}" style="margin-bottom:8px">${av.icon} ${av.label}</div>
    <div class="map-popup-grid">
      <div class="map-popup-item"><label>Type</label><span>${h.type}</span></div>
      <div class="map-popup-item"><label>Area</label><span>${h.area||'—'} Marla</span></div>
      <div class="map-popup-item"><label>Price</label><span>${h.price?'PKR '+Number(h.price).toLocaleString():'—'}</span></div>
      <div class="map-popup-item"><label>Saved</label><span>${h.savedDate||'—'}</span></div>
    </div>
    ${roomsHTML ? `<div class="map-popup-rooms-label">Room Labels</div><div class="map-popup-tags">${roomsHTML}</div>` : ''}
    ${structBtn}
  `, { maxWidth: 280 });
}

function previewStructure(id) {
  const h = savedHouses.find(x => x.id === id);
  if (!h) { toast('Property not found', 2000); return; }
  if (!h.structure || !h.structure.rooms || h.structure.rooms.length === 0) {
    toast('No structure drawing saved for this property', 2500);
    return;
  }
  structRooms   = [...h.structure.rooms];
  structWalls   = [...(h.structure.walls || [])];
  structureData = h.structure;
  document.getElementById('popup-subtitle').textContent = `${h.owner} — ${h.address}`;
  document.getElementById('struct-overlay').classList.add('open');
  setTimeout(() => {
    resizeCanvas();
    renderDrawRoomList();
    renderLegend();
    redrawCanvas();
  }, 90);
}

// ═══════════════════════════════════════
// LOAD HOUSES FROM DATABASE
// ═══════════════════════════════════════
async function loadHousesFromDB() {
  try {
    const res  = await fetch(`${API}/houses`);
    if (!res.ok) throw new Error('Server error ' + res.status);
    const data = await res.json();
    Object.values(savedPolygons).forEach(p => map.removeLayer(p));
    savedPolygons = {};
    savedHouses   = data;
    savedHouses.forEach(h => plotSavedHouse(h));
    updateStats(); renderSavedList();
    console.log(`Loaded ${savedHouses.length} houses from database`);
  } catch (err) {
    // Offline fallback
    console.warn('Server offline — using localStorage', err.message);
    savedHouses = JSON.parse(localStorage.getItem('piq_houses') || '[]');
    savedHouses.forEach(h => plotSavedHouse(h));
    updateStats(); renderSavedList();
    if (savedHouses.length === 0) toast('Offline mode — start Node.js server to load database', 4000);
  }
}

// ═══════════════════════════════════════
// SAVED HOUSES LIST — RENDER
// ═══════════════════════════════════════
function renderSavedList() {
  const list  = document.getElementById('saved-list');
  const query = document.getElementById('search-input').value.toLowerCase().trim();
  const avFilters = Object.keys(AVAIL);

  const filtered = savedHouses.filter(h => {
    const matchFilter =
      activeFilter === 'all'
      || (activeFilter === 'verified'          ? h.isVerified
        : avFilters.includes(activeFilter)     ? h.availability === activeFilter
        : h.type === activeFilter);
    const av = getAV(h);
    const matchSearch = !query
      || (h.owner+h.address+h.type+(h.area||'')+av.label).toLowerCase().includes(query);
    return matchFilter && matchSearch;
  });

  document.getElementById('result-count').textContent =
    `${filtered.length} of ${savedHouses.length} properties`;

  if (!filtered.length) {
    list.innerHTML = `<div class="no-results"><div class="no-results-icon">🔍</div>No properties found.<br/>Try a different search or filter.</div>`;
    return;
  }

  list.innerHTML = filtered.map(h => {
    const sc = h.isVerified ? 'ctag-verified' : (h.status==='Draft' ? 'ctag-draft' : 'ctag-saved');
    const sl = h.isVerified ? 'Verified' : (h.status || 'Saved');
    const av = getAV(h);

    const verifySection = h.isVerified
      ? `<div class="verify-section">
           <div class="verified-badge">✓ Verified Property</div>
           <div class="verified-by">By: ${h.verifiedBy||'City Planner'} on ${h.verifiedDate||''}</div>
           <button class="btn-verify btn-unverify" onclick="event.stopPropagation();unverifyHouse(${h.id})">Remove Verification</button>
         </div>`
      : `<div class="verify-section">
           <div class="unverified-badge">⚠ Awaiting Verification</div>
           <div class="verify-checklist" id="chk-${h.id}">
             <label class="chk-row"><input type="checkbox" onclick="event.stopPropagation()"/> Owner CNIC confirmed</label>
             <label class="chk-row"><input type="checkbox" onclick="event.stopPropagation()"/> Boundary matches actual plot</label>
             <label class="chk-row"><input type="checkbox" onclick="event.stopPropagation()"/> Area and rooms verified on site</label>
             <label class="chk-row"><input type="checkbox" onclick="event.stopPropagation()"/> No legal disputes on record</label>
           </div>
           <button class="btn-verify" onclick="event.stopPropagation();verifyHouse(${h.id})">✓ Verify This Property</button>
         </div>`;

    return `<div class="house-card" id="card-${h.id}" onclick="focusHouse(${h.id})">
      <div class="card-top">
        <div class="card-owner">${h.owner}</div>
        <button class="card-delete-btn" onclick="event.stopPropagation();confirmDelete(${h.id})" title="Delete">✕</button>
      </div>
      <div class="card-addr-row">
        <div class="card-addr">${h.address}</div>
        <span class="avail-badge avail-${h.availability||'available'}" style="font-size:0.6rem;padding:2px 7px;margin:0;flex-shrink:0">${av.icon} ${av.label}</span>
      </div>
      <div class="card-tags">
        <span class="ctag ctag-type">${h.type}</span>
        ${h.area ? `<span class="ctag ctag-area">${h.area} Marla</span>` : ''}
        ${h.structure ? `<span class="ctag ctag-rooms">${h.structure.rooms.length} rooms</span>` : ''}
        <span class="ctag ${sc}">${sl}</span>
      </div>
      ${verifySection}
      <div class="confirm-del-row" id="confirm-${h.id}">
        <span class="confirm-del-text">Delete "${h.owner}"?</span>
        <div class="confirm-del-btns">
          <button class="btn-confirm-yes" onclick="event.stopPropagation();deleteHouse(${h.id})">Yes, Delete</button>
          <button class="btn-confirm-no"  onclick="event.stopPropagation();cancelDelete(${h.id})">Cancel</button>
        </div>
      </div>
      ${(h.structure && h.structure.rooms && h.structure.rooms.length > 0)
        ? `<button class="btn-struct-view" onclick="event.stopPropagation();previewStructure(${h.id})">
             🏠 View House Structure (${h.structure.rooms.length} rooms)
           </button>` : ''}
      <button class="btn-avail-change" onclick="event.stopPropagation();openAvailModal(${h.id})">Change Availability</button>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════
// VERIFY / UNVERIFY
// ═══════════════════════════════════════
async function verifyHouse(id) {
  const h = savedHouses.find(x => x.id === id); if (!h) return;
  const checks = document.querySelectorAll(`#chk-${id} input[type=checkbox]`);
  if (![...checks].every(c => c.checked)) { toast('Tick all 4 checklist items first', 2500); return; }
  try {
    const res = await fetch(`${API}/houses/${id}/verify`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({verify:true}) });
    await res.json();
  } catch (e) {}
  h.isVerified = true; h.verifiedBy = 'City Planner'; h.verifiedDate = new Date().toLocaleDateString(); h.status = 'Verified';
  localStorage.setItem('piq_houses', JSON.stringify(savedHouses));
  updateStats(); renderSavedList(); toast(`"${h.owner}" is now Verified!`, 2500);
}

async function unverifyHouse(id) {
  const h = savedHouses.find(x => x.id === id); if (!h) return;
  try {
    await fetch(`${API}/houses/${id}/verify`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({verify:false}) });
  } catch (e) {}
  h.isVerified = false; h.verifiedBy = ''; h.verifiedDate = ''; h.status = 'Saved';
  localStorage.setItem('piq_houses', JSON.stringify(savedHouses));
  updateStats(); renderSavedList(); toast(`Verification removed from "${h.owner}"`, 2000);
}

// ═══════════════════════════════════════
// AVAILABILITY MODAL
// ═══════════════════════════════════════
function openAvailModal(id) {
  const h = savedHouses.find(x => x.id === id); if (!h) return;
  const old = document.getElementById('avail-modal'); if (old) old.remove();
  const current = h.availability || 'available';
  const opts = [
    { val:'available',          icon:'🟢', label:'Available — For Sale'    },
    { val:'for_rent',           icon:'🔵', label:'Available — For Rent'    },
    { val:'occupied',           icon:'🔴', label:'Occupied — Not For Sale' },
    { val:'under_construction', icon:'🟡', label:'Under Construction'      },
    { val:'rented',             icon:'🟣', label:'Rented Out'              },
  ];
  const modal = document.createElement('div');
  modal.id = 'avail-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:8000;display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:#161616;border:1.5px solid #dc2626;border-radius:13px;padding:20px;width:300px;max-width:92vw;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-family:'Playfair Display',serif;font-size:1rem;color:#f0eeea">Change Availability</div>
        <button onclick="document.getElementById('avail-modal').remove()" style="background:none;border:none;color:#666;font-size:1.1rem;cursor:pointer">✕</button>
      </div>
      <div style="font-size:0.73rem;color:#666;margin-bottom:12px">${h.owner} — ${h.address}</div>
      <div style="display:flex;flex-direction:column;gap:7px">
        ${opts.map(o => `
          <button onclick="setAvailability(${id},'${o.val}')"
            style="padding:10px 13px;border-radius:8px;text-align:left;display:flex;align-items:center;gap:10px;cursor:pointer;transition:all 0.15s;font-family:'Outfit',sans-serif;font-size:0.83rem;font-weight:500;
                   border:1.5px solid ${current===o.val?'#dc2626':'#2a2a2a'};
                   background:${current===o.val?'rgba(220,38,38,0.1)':'#111'};
                   color:${current===o.val?'#f87171':'#c8c4bc'}">
            <span>${o.icon}</span><span>${o.label}</span>
            ${current===o.val?'<span style="margin-left:auto;font-size:0.68rem;color:#dc2626">Current</span>':''}
          </button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function setAvailability(id, val) {
  const h = savedHouses.find(x => x.id === id); if (!h) return;
  try {
    await fetch(`${API}/houses/${id}/availability`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({availability:val}) });
  } catch (e) {}
  h.availability = val;
  localStorage.setItem('piq_houses', JSON.stringify(savedHouses));
  const modal = document.getElementById('avail-modal'); if (modal) modal.remove();
  renderSavedList(); toast(`"${h.owner}" marked as ${getAV(h).label}`, 2000);
}

// ═══════════════════════════════════════
// DELETE PROPERTY
// ═══════════════════════════════════════
function confirmDelete(id) {
  document.querySelectorAll('.confirm-del-row').forEach(r => r.style.display = 'none');
  const row = document.getElementById('confirm-' + id);
  if (row) row.style.display = 'flex';
}

function cancelDelete(id) {
  const row = document.getElementById('confirm-' + id);
  if (row) row.style.display = 'none';
}

async function deleteHouse(id) {
  const h = savedHouses.find(x => x.id === id); if (!h) return;
  if (h.isVerified) { toast('Cannot delete verified properties. Remove verification first.', 3000); cancelDelete(id); return; }
  const name = h.owner;
  try {
    const res  = await fetch(`${API}/houses/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success && data.error) { toast(data.error, 3000); return; }
  } catch (e) {}
  if (savedPolygons[id]) { map.removeLayer(savedPolygons[id]); delete savedPolygons[id]; }
  savedHouses = savedHouses.filter(x => x.id !== id);
  localStorage.setItem('piq_houses', JSON.stringify(savedHouses));
  const card = document.getElementById('card-' + id);
  if (card) {
    card.style.transition = 'opacity 0.3s, transform 0.3s';
    card.style.opacity    = '0'; card.style.transform = 'translateX(-20px)';
    setTimeout(() => { updateStats(); renderSavedList(); }, 300);
  } else { updateStats(); renderSavedList(); }
  toast(`"${name}" deleted`, 2500);
}

// ═══════════════════════════════════════
// FILTER & SEARCH
// ═══════════════════════════════════════
function filterSaved() { renderSavedList(); }

function setFilter(el) {
  activeFilter = el.dataset.f;
  document.querySelectorAll('.fchip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderSavedList();
}

function focusHouse(id) {
  const h = savedHouses.find(x => x.id === id); if (!h || !h.points?.length) return;
  map.flyToBounds(L.latLngBounds(h.points.map(p => [p.lat, p.lng])), { padding:[60,60], duration:1.2 });
  document.querySelectorAll('.house-card').forEach(c => c.classList.remove('highlighted'));
  const card = document.getElementById('card-' + id);
  if (card) card.classList.add('highlighted');
}

// ═══════════════════════════════════════
// STATS
// ═══════════════════════════════════════
function updateStats() {
  document.getElementById('stat-total').textContent    = savedHouses.length;
  document.getElementById('stat-verified').textContent = savedHouses.filter(h => h.isVerified).length;
}


// ═══════════════════════════════════════
// LIVE AREA CALCULATION
// Shoelace formula — calculates polygon
// area from lat/lng in square metres
// 1 Marla (Pakistan) = 25.2929 sq metres
// ═══════════════════════════════════════
function calcAreaSqM(points) {
  const n = points.length;
  if (n < 3) return 0;
  // Convert lat/lng degrees to metres using equirectangular projection
  const R    = 6371000;
  const lat0 = points[0].lat * Math.PI / 180;
  const pts  = points.map(p => ({
    x: (p.lng * Math.PI / 180) * R * Math.cos(lat0),
    y: (p.lat * Math.PI / 180) * R
  }));
  // Shoelace formula
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j  = (i + 1) % n;
    area    += pts[i].x * pts[j].y;
    area    -= pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
}

function updateLiveArea(final = false) {
  if (drawPoints.length < 3) { hideLiveArea(); return; }

  const sqm   = calcAreaSqM(drawPoints);
  const sqft  = sqm * 10.7639;
  const marla = sqm / 25.2929;

  // Show the live area box
  const box = document.getElementById('live-area-box');
  box.style.display = 'block';
  document.getElementById('live-marla').textContent = marla.toFixed(2);
  document.getElementById('live-sqft').textContent  = Math.round(sqft).toLocaleString();
  document.getElementById('live-sqm').textContent   = Math.round(sqm).toLocaleString();

  // Auto-fill the Area (Marla) input in property form
  document.getElementById('f-area').value = marla.toFixed(2);

  if (final) {
    // Turn green when polygon is closed — final measurement locked
    box.classList.add('live-area-final-state');
    document.getElementById('live-marla').style.color = '#4ade80';
    document.getElementById('live-final-msg').style.display = 'block';
  } else {
    // Red while still drawing
    box.classList.remove('live-area-final-state');
    document.getElementById('live-marla').style.color = '#dc2626';
    document.getElementById('live-final-msg').style.display = 'none';
  }
}

function hideLiveArea() {
  const box = document.getElementById('live-area-box');
  if (box) {
    box.style.display = 'none';
    box.classList.remove('live-area-final-state');
  }
  document.getElementById('live-marla').style.color = '#dc2626';
  document.getElementById('live-final-msg').style.display = 'none';
  document.getElementById('f-area').value = '';
}

// ═══════════════════════════════════════
// STEP GUIDE UPDATES
// ═══════════════════════════════════════
function updateSteps() {
  const S = (id,cls) => { const e=document.getElementById(id); if(e) e.className='step-item '+cls; };
  const N = (id,v)   => { const e=document.getElementById(id); if(e) e.textContent=v; };
  S('s1', locationSet ? 'done' : 'active');
  N('s1n', locationSet ? '✓' : '1');
  S('s2', locationSet && !drawPoints.length ? 'active' : drawPoints.length ? 'done' : '');
  N('s2n', drawPoints.length ? '✓' : '2');
  S('s3', drawPoints.length && !polygonClosed ? 'active' : polygonClosed ? 'done' : '');
  N('s3n', polygonClosed ? '✓' : '3');
  S('s4', polygonClosed && !structureData ? 'active' : structureData ? 'done' : '');
  N('s4n', structureData ? '✓' : '4');
  S('s5', structureData ? 'active' : '');
  N('s5n', '5');
}

// ═══════════════════════════════════════
// COORDINATE PANEL
// ═══════════════════════════════════════
function updateCoords() {
  document.getElementById('pt-count').textContent = drawPoints.length;
  const el = document.getElementById('coord-list');
  if (!drawPoints.length) {
    el.innerHTML = `<div class="coord-empty">Search a location, then click the map to add points</div>`;
    return;
  }
  el.innerHTML = drawPoints.map((p,i) => `
    <div class="coord-row">
      <span class="coord-idx">${i+1}</span>
      <span class="coord-val">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span>
    </div>`).join('');
  el.scrollTop = el.scrollHeight;
}

// ═══════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════
function switchTab(t) {
  mode = t === 'room' ? 'room' : 'draw';
  ['draw','room','saved'].forEach(n => {
    document.getElementById('tab-'     + n).style.display = n===t ? 'flex'  : 'none';
    document.getElementById('btn-tab-' + n).classList.toggle('active', n===t);
  });
  if (t === 'room')  renderRoomGrid();
  if (t === 'saved') renderSavedList();
}

// ═══════════════════════════════════════
// TOAST NOTIFICATION
// ═══════════════════════════════════════
function toast(msg, dur = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}

// ═══════════════════════════════════════
// INITIALISE — loads from DB or localStorage
// ═══════════════════════════════════════
async function init() {
  await loadHousesFromDB();
  renderRoomGrid(); updateSteps(); updateCoords();
}
init();