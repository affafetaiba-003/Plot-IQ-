const express = require('express');
const sql     = require('mssql');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const dbConfig = {
  user:     'sa',
  password: 'Sa123456!',
  server:   'localhost',
  database: 'PlotIQ',
  options:  {
    encrypt:                false,
    trustServerCertificate: true,
    enableArithAbort:       true
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

let pool;
sql.connect(dbConfig)
  .then(p => {
    pool = p;
    console.log('');
    console.log('✅ Connected to PlotIQ database!');
    console.log('🌐 Open: http://localhost:3000/api/status');
    console.log('');
  })
  .catch(err => {
    console.error('❌ Connection error:', err.message);
  });

function checkDB(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Database not connected' });
  next();
}

app.get('/api/status', (req, res) => {
  res.json({ server: 'PlotIQ', database: pool ? 'connected' : 'disconnected' });
});

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

app.post('/api/houses', checkDB, async (req, res) => {
  const { owner, address, type, area, price, year, availability, points, rooms, structure } = req.body;
  if (!owner || !points || points.length < 3)
    return res.status(400).json({ error: 'Missing required fields' });
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    let ownerID;
    const oc = await tx.request().input('n', sql.VarChar(100), owner)
      .query('SELECT OwnerID FROM OWNERS WHERE FullName=@n');
    if (oc.recordset.length > 0) {
      ownerID = oc.recordset[0].OwnerID;
    } else {
      const no = await tx.request()
        .input('n',     sql.VarChar(100), owner)
        .input('phone', sql.VarChar(20),  null)
        .input('cnic',  sql.VarChar(20),  null)
        .input('email', sql.VarChar(100), null)
        .query(`INSERT INTO OWNERS (FullName, Phone, CNIC, Email)
                OUTPUT INSERTED.OwnerID
                VALUES (@n, @phone, @cnic, @email)`);
      ownerID = no.recordset[0].OwnerID;
    }
    const tr = await tx.request().input('t', sql.VarChar(50), type)
      .query('SELECT TypeID FROM PROPERTY_TYPES WHERE TypeName=@t');
    const typeID = tr.recordset[0]?.TypeID || 1;
    const cLat = points.reduce((s,p) => s+p.lat,0)/points.length;
    const cLng = points.reduce((s,p) => s+p.lng,0)/points.length;

    // Get CityID dynamically — use first city in table, never hardcode
    const cityRes = await tx.request()
      .query('SELECT TOP 1 CityID FROM CITIES ORDER BY CityID ASC');
    const cityID = cityRes.recordset[0]?.CityID || 1;

    const pr = await tx.request()
      .input('oid',   sql.Int,           ownerID)
      .input('cid',   sql.Int,           cityID)
      .input('tid',   sql.Int,           typeID)
      .input('addr',  sql.VarChar(255),  address)
      .input('price', sql.Decimal(14,2), parseFloat(price)||0)
      .input('clat',  sql.Float,         cLat)
      .input('clng',  sql.Float,         cLng)
      .query(`INSERT INTO PROPERTIES(OwnerID,CityID,TypeID,Address,Price,RegisteredDate,CenterLat,CenterLng)
              OUTPUT INSERTED.PropertyID
              VALUES(@oid,@cid,@tid,@addr,@price,GETDATE(),@clat,@clng)`);
    const propertyID = pr.recordset[0].PropertyID;
    for (let i = 0; i < points.length; i++) {
      await tx.request()
        .input('pid', sql.Int,   propertyID)
        .input('ord', sql.Int,   i+1)
        .input('lat', sql.Float, points[i].lat)
        .input('lng', sql.Float, points[i].lng)
        .query('INSERT INTO BOUNDARY_POINTS(PropertyID,PointOrder,Latitude,Longitude) VALUES(@pid,@ord,@lat,@lng)');
    }
    for (let r of (rooms||[])) {
      await tx.request()
        .input('pid',   sql.Int,          propertyID)
        .input('name',  sql.VarChar(100), r.name)
        .input('color', sql.VarChar(20),  r.color)
        .input('lat',   sql.Float,        r.lat||0)
        .input('lng',   sql.Float,        r.lng||0)
        .query('INSERT INTO ROOMS(PropertyID,RoomName,ColorCode,LabelLat,LabelLng) VALUES(@pid,@name,@color,@lat,@lng)');
    }
    const marlaVal = parseFloat(area)||0;
    await tx.request()
      .input('pid',   sql.Int,          propertyID)
      .input('marla', sql.Float,        marlaVal)
      .input('sqm',   sql.Float,        marlaVal*25.2929)
      .input('sqft',  sql.Float,        marlaVal*272.25)
      .input('year',  sql.Int,          parseInt(year)||0)
      .input('avail',  sql.VarChar(30),  availability||'available')
      .input('struct', sql.NVarChar(sql.MAX), structure ? JSON.stringify(structure) : null)
      .query(`INSERT INTO PROPERTY_DETAILS
                (PropertyID,AreaMarla,AreaSqM,AreaSqFt,YearBuilt,
                 Availability,Status,TotalRooms,SavedDate,IsVerified,StructureData)
              VALUES(@pid,@marla,@sqm,@sqft,@year,@avail,'Saved',0,GETDATE(),0,@struct)`);
    await tx.commit();
    console.log('✅ Saved: ' + owner);
    res.json({ success: true, propertyID });
  } catch (err) {
    await tx.rollback();
    console.error('POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/houses/:id', checkDB, async (req, res) => {
  const id = parseInt(req.params.id);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const chk = await tx.request().input('id',sql.Int,id)
      .query('SELECT ISNULL(IsVerified,0) AS v FROM PROPERTY_DETAILS WHERE PropertyID=@id');
    if (chk.recordset[0]?.v === 1) {
      await tx.rollback();
      return res.status(403).json({ error: 'Cannot delete verified property. Remove verification first.' });
    }
    await tx.request().input('id',sql.Int,id).query('DELETE FROM ROOMS WHERE PropertyID=@id');
    await tx.request().input('id',sql.Int,id).query('DELETE FROM BOUNDARY_POINTS WHERE PropertyID=@id');
    await tx.request().input('id',sql.Int,id).query('DELETE FROM PROPERTY_DETAILS WHERE PropertyID=@id');
    await tx.request().input('id',sql.Int,id).query('DELETE FROM PROPERTIES WHERE PropertyID=@id');
    await tx.commit();
    res.json({ success: true });
  } catch (err) {
    await tx.rollback();
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/houses/:id/verify', checkDB, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (req.body.verify) {
      await pool.request().input('id',sql.Int,id)
        .query(`UPDATE PROPERTY_DETAILS SET IsVerified=1,Status='Verified',VerifiedBy='City Planner',VerifiedDate=GETDATE() WHERE PropertyID=@id`);
    } else {
      await pool.request().input('id',sql.Int,id)
        .query(`UPDATE PROPERTY_DETAILS SET IsVerified=0,Status='Saved',VerifiedBy=NULL,VerifiedDate=NULL WHERE PropertyID=@id`);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/houses/:id/availability', checkDB, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.request()
      .input('id', sql.Int,         id)
      .input('v',  sql.VarChar(30), req.body.availability)
      .query('UPDATE PROPERTY_DETAILS SET Availability=@v WHERE PropertyID=@id');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(3000, () => {
  console.log('════════════════════════════════');
  console.log('   PlotIQ Server — Port 3000');
  console.log('   http://localhost:3000/api/status');
  console.log('════════════════════════════════');
});