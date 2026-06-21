/* ═══════════════════════════════════════════════════
   PlotIQ — server.js
   Complete backend — PlotIQ Smart City Registry
═══════════════════════════════════════════════════ */

const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));           // 50mb for base64 structure image
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ═══════════════════════════════════════════════════
// SQL SERVER CONFIG
// ═══════════════════════════════════════════════════
const dbConfig = {
  user: 'sa',
  password: 'Sa123456!',
  server: 'localhost',
  database: 'PlotIQ',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

let pool;
sql.connect(dbConfig)
  .then(p => {
    pool = p;
    console.log('');
    console.log('✅ Connected to PlotIQ database!');
    console.log('🌐 Server: http://localhost:3000/api/status');
    console.log('');
  })
  .catch(err => {
    console.error('❌ DB Connection error:', err.message);
  });

function checkDB(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Database not connected' });
  next();
}

// ═══════════════════════════════════════════════════
// ROUTE 1 — STATUS CHECK
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// AUTH ROUTES — Login, Register, Users
// ═══════════════════════════════════════════════════

// POST /api/login — Sign in
app.post('/api/login', checkDB, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  try {
    const result = await pool.request()
      .input('u', sql.VarChar(50), username.trim())
      .input('p', sql.VarChar(255), password.trim())
      .query(`SELECT UserID, FullName, Username, Email, Role
              FROM USERS
              WHERE Username = @u AND Password = @p AND IsActive = 1`);
    if (!result.recordset.length)
      return res.status(401).json({ error: 'Invalid Login ID or Password. Account may be pending approval.' });
    const user = result.recordset[0];
    // Update last login timestamp
    await pool.request()
      .input('id', sql.Int, user.UserID)
      .query('UPDATE USERS SET LastLogin = GETDATE() WHERE UserID = @id');
    console.log('✅ Login: ' + user.FullName + ' (' + user.Role + ')');
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/register — Create new account (pending approval)
app.post('/api/register', checkDB, async (req, res) => {
  const { fullName, username, email, role, password } = req.body;
  if (!fullName || !username || !email || !password)
    return res.status(400).json({ error: 'All fields are required' });
  try {
    // Check if username already exists
    const chk = await pool.request()
      .input('u', sql.VarChar(50), username.trim())
      .query('SELECT UserID FROM USERS WHERE Username = @u');
    if (chk.recordset.length > 0)
      return res.status(409).json({ error: 'Login ID already taken. Please choose a different one.' });
    // Check if email already exists
    const echk = await pool.request()
      .input('e', sql.VarChar(150), email.trim())
      .query('SELECT UserID FROM USERS WHERE Email = @e');
    if (echk.recordset.length > 0)
      return res.status(409).json({ error: 'Email already registered.' });
    // Insert new user — IsActive=0 means pending approval
    await pool.request()
      .input('n', sql.VarChar(100), fullName.trim())
      .input('u', sql.VarChar(50), username.trim())
      .input('e', sql.VarChar(150), email.trim())
      .input('p', sql.VarChar(255), password)
      .input('r', sql.VarChar(20), role || 'dealer')
      .query(`INSERT INTO USERS (FullName, Username, Email, Password, Role, IsActive)
              VALUES (@n, @u, @e, @p, @r, 0)`);
    console.log('✅ New account registered: ' + username + ' (pending approval)');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/check-username — Check if username is available
app.get('/api/check-username', checkDB, async (req, res) => {
  const u = req.query.u;
  if (!u) return res.json({ available: false });
  try {
    const result = await pool.request()
      .input('u', sql.VarChar(50), u.trim())
      .query('SELECT UserID FROM USERS WHERE Username = @u');
    res.json({ available: result.recordset.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users — Get all system users (for Owners tab)
app.get('/api/users', checkDB, async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT
        u.UserID,
        u.FullName,
        u.Username,
        u.Email,
        u.Role,
        u.IsActive,
        CONVERT(VARCHAR, u.CreatedAt, 103)  AS CreatedAt,
        CONVERT(VARCHAR, u.LastLogin, 103)  AS LastLogin
      FROM USERS u
      ORDER BY u.Role, u.FullName
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/:id/activate — Activate or deactivate user
app.patch('/api/users/:id/activate', checkDB, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.request()
      .input('id', sql.Int, id)
      .input('v', sql.Bit, req.body.active ? 1 : 0)
      .query('UPDATE USERS SET IsActive = @v WHERE UserID = @id');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    server: 'PlotIQ',
    database: pool ? 'connected' : 'disconnected',
    time: new Date().toLocaleString()
  });
});

// ═══════════════════════════════════════════════════
// ROUTE 2 — GET ALL HOUSES
// ═══════════════════════════════════════════════════
app.get('/api/houses', checkDB, async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT
        p.PropertyID                             AS id,
        o.FullName                               AS owner,
        p.Address                                AS address,
        pt.TypeName                              AS type,
        ISNULL(pd.AreaMarla, 0)                  AS area,
        p.Price                                  AS price,
        ISNULL(pd.YearBuilt, 0)                  AS year,
        ISNULL(pd.Status, 'Saved')               AS status,
        ISNULL(pd.IsVerified, 0)                 AS isVerified,
        ISNULL(pd.VerifiedBy, '')                AS verifiedBy,
        ISNULL(pd.Availability, 'available')     AS availability,
        CONVERT(VARCHAR, pd.SavedDate,    103)   AS savedDate,
        CONVERT(VARCHAR, pd.VerifiedDate, 103)   AS verifiedDate,
        p.CenterLat, p.CenterLng,
        pd.StructureData
      FROM      PROPERTIES       p
      JOIN      OWNERS           o  ON p.OwnerID    = o.OwnerID
      JOIN      PROPERTY_TYPES   pt ON p.TypeID     = pt.TypeID
      LEFT JOIN PROPERTY_DETAILS pd ON p.PropertyID = pd.PropertyID
      ORDER BY  p.RegisteredDate DESC
    `);

    const houses = result.recordset;
    for (let h of houses) {
      const pts = await pool.request().input('id', sql.Int, h.id)
        .query('SELECT Latitude AS lat, Longitude AS lng FROM BOUNDARY_POINTS WHERE PropertyID=@id ORDER BY PointOrder');
      h.points = pts.recordset;

      const rooms = await pool.request().input('id', sql.Int, h.id)
        .query('SELECT RoomName AS name, ColorCode AS color, LabelLat AS lat, LabelLng AS lng FROM ROOMS WHERE PropertyID=@id');
      h.rooms = rooms.recordset;

      h.isVerified = h.isVerified === 1 || h.isVerified === true;
      h.structure = h.StructureData ? JSON.parse(h.StructureData) : null;
      delete h.StructureData;
    }

    console.log('📤 Sent ' + houses.length + ' houses to frontend');
    res.json(houses);

  } catch (err) {
    console.error('GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
// ROUTE 3 — SAVE NEW HOUSE
// ═══════════════════════════════════════════════════
app.post('/api/houses', checkDB, async (req, res) => {
  const {
    owner, address, type, area, price,
    year, availability, points, rooms,
    structure
  } = req.body;

  if (!owner || !points || points.length < 3)
    return res.status(400).json({ error: 'Owner, address and 3+ boundary points required' });

  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();

    // ── Find or create Owner ──────────────────────
    let ownerID;
    const oc = await tx.request()
      .input('n', sql.VarChar(100), owner)
      .query('SELECT OwnerID FROM OWNERS WHERE FullName = @n');

    if (oc.recordset.length > 0) {
      ownerID = oc.recordset[0].OwnerID;
    } else {
      const no = await tx.request()
        .input('n', sql.VarChar(100), owner)
        .input('phone', sql.VarChar(20), null)
        .input('cnic', sql.VarChar(20), null)
        .input('email', sql.VarChar(100), null)
        .query(`INSERT INTO OWNERS (FullName, Phone, CNIC, Email)
                OUTPUT INSERTED.OwnerID
                VALUES (@n, @phone, @cnic, @email)`);
      ownerID = no.recordset[0].OwnerID;
    }

    // ── Get TypeID ────────────────────────────────
    const tr = await tx.request()
      .input('t', sql.VarChar(50), type)
      .query('SELECT TypeID FROM PROPERTY_TYPES WHERE TypeName = @t');
    const typeID = tr.recordset[0]?.TypeID || 1;

    // ── Get CityID dynamically ────────────────────
    const cityRes = await tx.request()
      .query('SELECT TOP 1 CityID FROM CITIES ORDER BY CityID ASC');
    const cityID = cityRes.recordset[0]?.CityID || 1;

    // ── Calculate polygon centre ──────────────────
    const cLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const cLng = points.reduce((s, p) => s + p.lng, 0) / points.length;

    // ── Insert into PROPERTIES ────────────────────
    const pr = await tx.request()
      .input('oid', sql.Int, ownerID)
      .input('cid', sql.Int, cityID)
      .input('tid', sql.Int, typeID)
      .input('addr', sql.VarChar(255), address)
      .input('price', sql.Decimal(14, 2), parseFloat(price) || 0)
      .input('clat', sql.Float, cLat)
      .input('clng', sql.Float, cLng)
      .query(`INSERT INTO PROPERTIES
                (OwnerID,CityID,TypeID,Address,Price,RegisteredDate,CenterLat,CenterLng)
              OUTPUT INSERTED.PropertyID
              VALUES(@oid,@cid,@tid,@addr,@price,GETDATE(),@clat,@clng)`);
    const propertyID = pr.recordset[0].PropertyID;

    // ── Insert BOUNDARY_POINTS ────────────────────
    for (let i = 0; i < points.length; i++) {
      await tx.request()
        .input('pid', sql.Int, propertyID)
        .input('ord', sql.Int, i + 1)
        .input('lat', sql.Float, points[i].lat)
        .input('lng', sql.Float, points[i].lng)
        .query('INSERT INTO BOUNDARY_POINTS(PropertyID,PointOrder,Latitude,Longitude) VALUES(@pid,@ord,@lat,@lng)');
    }

    // ── Insert ROOMS ──────────────────────────────
    for (let r of (rooms || [])) {
      await tx.request()
        .input('pid', sql.Int, propertyID)
        .input('name', sql.VarChar(100), r.name)
        .input('color', sql.VarChar(20), r.color)
        .input('lat', sql.Float, r.lat || 0)
        .input('lng', sql.Float, r.lng || 0)
        .query('INSERT INTO ROOMS(PropertyID,RoomName,ColorCode,LabelLat,LabelLng) VALUES(@pid,@name,@color,@lat,@lng)');
    }

    // ── Insert PROPERTY_DETAILS ───────────────────
    const marlaVal = parseFloat(area) || 0;

    // Store structure WITHOUT image in DB (image is too large for DB)
    // Image is not stored in DB — too large
    const structForDB = structure ? {
      rooms: structure.rooms,
      walls: structure.walls,
      canvasW: structure.canvasW,
      canvasH: structure.canvasH
      // image intentionally excluded from DB
    } : null;

    await tx.request()
      .input('pid', sql.Int, propertyID)
      .input('marla', sql.Float, marlaVal)
      .input('sqm', sql.Float, marlaVal * 25.2929)
      .input('sqft', sql.Float, marlaVal * 272.25)
      .input('year', sql.Int, parseInt(year) || 0)
      .input('avail', sql.VarChar(30), availability || 'available')
      .input('struct', sql.NVarChar(sql.MAX), structForDB ? JSON.stringify(structForDB) : null)
      .query(`INSERT INTO PROPERTY_DETAILS
                (PropertyID,AreaMarla,AreaSqM,AreaSqFt,YearBuilt,
                 Availability,Status,TotalRooms,SavedDate,IsVerified,StructureData)
              VALUES(@pid,@marla,@sqm,@sqft,@year,@avail,'Saved',0,GETDATE(),0,@struct)`);

    await tx.commit();
    console.log('✅ Saved: ' + owner + ' — PropertyID: ' + propertyID);

    res.json({ success: true, propertyID });

  } catch (err) {
    await tx.rollback();
    console.error('POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
// ROUTE 4 — DELETE HOUSE
// ═══════════════════════════════════════════════════
app.delete('/api/houses/:id', checkDB, async (req, res) => {
  const id = parseInt(req.params.id);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const chk = await tx.request().input('id', sql.Int, id)
      .query('SELECT ISNULL(IsVerified,0) AS v FROM PROPERTY_DETAILS WHERE PropertyID=@id');
    if (chk.recordset[0]?.v === 1) {
      await tx.rollback();
      return res.status(403).json({ error: 'Cannot delete verified property. Remove verification first.' });
    }
    await tx.request().input('id', sql.Int, id).query('DELETE FROM ROOMS            WHERE PropertyID=@id');
    await tx.request().input('id', sql.Int, id).query('DELETE FROM BOUNDARY_POINTS  WHERE PropertyID=@id');
    await tx.request().input('id', sql.Int, id).query('DELETE FROM PROPERTY_DETAILS WHERE PropertyID=@id');
    await tx.request().input('id', sql.Int, id).query('DELETE FROM PROPERTIES       WHERE PropertyID=@id');
    await tx.commit();
    console.log('🗑️  Deleted PropertyID: ' + id);
    res.json({ success: true });
  } catch (err) {
    await tx.rollback();
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
// ROUTE 5 — VERIFY / UNVERIFY
// ═══════════════════════════════════════════════════
app.patch('/api/houses/:id/verify', checkDB, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (req.body.verify) {
      await pool.request().input('id', sql.Int, id)
        .query(`UPDATE PROPERTY_DETAILS
                SET IsVerified=1, Status='Verified',
                    VerifiedBy='City Planner', VerifiedDate=GETDATE()
                WHERE PropertyID=@id`);
    } else {
      await pool.request().input('id', sql.Int, id)
        .query(`UPDATE PROPERTY_DETAILS
                SET IsVerified=0, Status='Saved',
                    VerifiedBy=NULL, VerifiedDate=NULL
                WHERE PropertyID=@id`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// ROUTE 6 — UPDATE AVAILABILITY
// ═══════════════════════════════════════════════════
app.patch('/api/houses/:id/availability', checkDB, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.request()
      .input('id', sql.Int, id)
      .input('v', sql.VarChar(30), req.body.availability)
      .query('UPDATE PROPERTY_DETAILS SET Availability=@v WHERE PropertyID=@id');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start server ─────────────────────────────────────
app.listen(3000, () => {
  console.log('════════════════════════════════');
  console.log('   PlotIQ Server — Port 3000');
  console.log('   http://localhost:3000/api/status');
  console.log('════════════════════════════════');
});
