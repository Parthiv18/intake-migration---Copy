// server.js
const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;
// Path to your SQLite file
const DB_PATH = path.join(__dirname, "intakedb.db");

// ——————————————————————————————————————————
// 1. Parse JSON bodies
app.use(express.json());
// 2. Serve static files (including your HTML/CSS/JS)
app.use(express.static(__dirname));

// 3. Open the database for read/write (and create if missing)
const db = new sqlite3.Database(
  DB_PATH,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) {
      console.error("Failed to open database:", err.message);
      process.exit(1);
    }
    console.log("Connected to SQLite database.");
  }
);

// ——————————————————————————————————————————
// Your existing GET /data endpoint
app.get("/data", (req, res) => {
  db.serialize(() => {
    db.all("SELECT * FROM jrm", (err, jrmRows) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all("SELECT * FROM metrics", (err2, metricsRows) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ jrm: jrmRows, metrics: metricsRows });
      });
    });
  });
});

// ——————————————————————————————————————————
// 4. NEW: POST /jrm — insert a new intake into the JRM table
app.post("/jrm", (req, res) => {
  const {
    intakeId,
    intakeName,
    intakeComments,
    intakeTags,
    status,
    attachment,
    date,
    approvedDate,
  } = req.body;

  const sql = `
    INSERT INTO jrm
      ("Intake ID","Intake Name","Intake Comments","Intake Tags",
       "Status","Attachment","Date","Approved Date")
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(
    sql,
    [
      intakeId,
      intakeName,
      intakeComments,
      intakeTags,
      status,
      attachment,
      date,
      approvedDate,
    ],
    function (err) {
      if (err) {
        console.error("JRM insert error:", err.message);
        return res.status(500).json({ error: err.message });
      }
      // return the new row’s ID (if you need it in the client)
      res.json({ success: true, rowid: this.lastID });
    }
  );
});

/**
 * 1. EDIT an intake (all fields)
 *    PUT /jrm/:intakeId
 */
app.put("/jrm/:intakeId", (req, res) => {
  const id = req.params.intakeId;
  const {
    intakeName,
    intakeComments,
    intakeTags,
    status,
    attachment,
    date,
    approvedDate,
  } = req.body;

  const sql = `
    UPDATE jrm
       SET "Intake Name"      = ?,
           "Intake Comments"  = ?,
           "Intake Tags"      = ?,
           "Status"           = ?,
           "Attachment"       = ?,
           "Date"             = ?,
           "Approved Date"    = ?
     WHERE "Intake ID"        = ?
  `;
  db.run(
    sql,
    [
      intakeName,
      intakeComments,
      intakeTags,
      status,
      attachment,
      date,
      approvedDate,
      id,
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, changes: this.changes });
    }
  );
});

/**
 * 2. MOVE an intake (just status)
 *    PATCH /jrm/:intakeId/status
 */
app.patch("/jrm/:intakeId/status", (req, res) => {
  const id = req.params.intakeId;
  const status = req.body.status; // e.g. "Approved", "Estimates", "OFS"
  const sql = `UPDATE jrm SET "Status" = ? WHERE "Intake ID" = ?`;
  db.run(sql, [status, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, changes: this.changes });
  });
});

/**
 * 3. ATTACH to an intake (just attachment column)
 *    PATCH /jrm/:intakeId/attachment
 */
app.patch("/jrm/:intakeId/attachment", (req, res) => {
  const id = req.params.intakeId;
  const attachment = req.body.attachment; // e.g. URL or filename
  const sql = `UPDATE jrm SET "Attachment" = ? WHERE "Intake ID" = ?`;
  db.run(sql, [attachment, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, changes: this.changes });
  });
});

/**
 * 4. DELETE an intake
 *    DELETE /jrm/:intakeId
 */
app.delete("/jrm/:intakeId", (req, res) => {
  const id = req.params.intakeId;
  const sql = `DELETE FROM jrm WHERE "Intake ID" = ?`;
  db.run(sql, [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

// ——————————————————————————————————————————

// 5. NEW: POST /metrics — insert a new metric row, guard against duplicates,
//    ensure Intake ID exists in jrm, and propagate approvedDate to jrm.
app.post("/metrics", (req, res) => {
  const {
    intakeId,
    intakeName,
    totalOngoingCosts,
    lobSubTotal,
    contingency,
    etBATotalEffortDays,
    etBATC,
    etBAEPercent,
    etBACPercent,
    etDevTotalEffortDays,
    etDevTC,
    etDevEPercent,
    etDevCPercent,
    etQATotalEffortDays,
    etQATC,
    etQAEPercent,
    etQACPercent,
    aotoTotalEffortDays,
    aotoTC,
    aotoEPercent,
    aotoCPercent,
    pmoTotalEffortDays,
    pmoTC,
    pmoEPercent,
    pmoCPercent,
    approvedDate, // this is the approved date coming from the metrics payload
  } = req.body;

  const normId = String(intakeId).replace(/^ENT-/i, "").trim();

  db.serialize(() => {
    // 1. Check Intake exists in jrm
    db.get(
      `SELECT 1 FROM jrm WHERE "Intake ID" = ?`,
      [`ENT-${normId}`],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) {
          return res
            .status(400)
            .json({ error: `Intake ID ENT-${normId} does not exist` });
        }

        // 2. Check no duplicate in metrics
        db.get(
          `SELECT 1 FROM metrics WHERE "Intake ID" = ?`,
          [`ENT-${normId}`],
          (err2, existing) => {
            if (err2) return res.status(500).json({ error: err2.message });
            if (existing) {
              return res
                .status(409)
                .json({ error: `Metrics for ENT-${normId} already exist` });
            }

            // 3. Insert into metrics
            const insertSql = `
              INSERT INTO metrics (
                "Intake ID", "Intake Name",
                "Total Ongoing Costs", "LOB Sub-Total", "Contingency",
                "ET-BA Total Effort Days", "ET-BA TC", "ET-BA E%", "ET-BA C%",
                "ET-Dev Total Effort Days", "ET-Dev TC", "ET-Dev E%", "ET-Dev C%",
                "ET-QA Total Effort Days", "ET-QA TC", "ET-QA E%", "ET-QA C%",
                "AO/TO Total Effort Days", "AO/TO TC", "AO/TO E%", "AO/TO C%",
                "PMO Total Effort Days", "PMO TC", "PMO E%", "PMO C%"
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const params = [
              `ENT-${normId}`,
              intakeName,
              totalOngoingCosts,
              lobSubTotal,
              contingency,
              etBATotalEffortDays,
              etBATC,
              etBAEPercent,
              etBACPercent,
              etDevTotalEffortDays,
              etDevTC,
              etDevEPercent,
              etDevCPercent,
              etQATotalEffortDays,
              etQATC,
              etQAEPercent,
              etQACPercent,
              aotoTotalEffortDays,
              aotoTC,
              aotoEPercent,
              aotoCPercent,
              pmoTotalEffortDays,
              pmoTC,
              pmoEPercent,
              pmoCPercent,
            ];
            db.run(insertSql, params, function (err3) {
              if (err3) {
                console.error("Metrics insert error:", err3.message);
                return res.status(500).json({ error: err3.message });
              }

              // 4. Update jrm approved date
              db.run(
                `UPDATE jrm SET "Approved Date" = ? WHERE "Intake ID" = ?`,
                [approvedDate, `ENT-${normId}`],
                function (err4) {
                  if (err4) {
                    console.error(
                      "Failed to update approved date:",
                      err4.message
                    );
                    // metrics row succeeded, but approved date update failed
                    return res.status(500).json({
                      success: true,
                      warning:
                        "Metrics inserted, but failed to update Approved Date on JRM",
                    });
                  }
                  res.json({
                    success: true,
                    metricRowId: this.lastID,
                    updatedApprovedDate: approvedDate,
                  });
                }
              );
            });
          }
        );
      }
    );
  });
});

/**
 * EDIT (all or some fields) a metric row
 * PUT /metrics/:intakeId
 */
app.put("/metrics/:intakeId", (req, res) => {
  const intakeId = req.params.intakeId; // e.g. 'ENT-17063'
  const updates = req.body; // { totalOngoingCosts: 123, approvedDate: '2025-07-10', … }

  // Normalize (strip leading ENT- if needed)
  const normId = String(intakeId).replace(/^ENT-/i, "").trim();
  const entId = `ENT-${normId}`;

  db.serialize(() => {
    // 1) Fetch existing metric row
    db.get(
      `SELECT * FROM metrics WHERE "Intake ID" = ?`,
      [entId],
      (err, existing) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!existing) {
          return res
            .status(404)
            .json({ error: `Metrics for ${entId} not found` });
        }

        // 2) Build merged object: for each column, use updates[field] if present, else existing[field]
        const cols = [
          "Intake Name",
          "Total Ongoing Costs",
          "LOB Sub-Total",
          "Contingency",
          "ET-BA Total Effort Days",
          "ET-BA TC",
          "ET-BA E%",
          "ET-BA C%",
          "ET-Dev Total Effort Days",
          "ET-Dev TC",
          "ET-Dev E%",
          "ET-Dev C%",
          "ET-QA Total Effort Days",
          "ET-QA TC",
          "ET-QA E%",
          "ET-QA C%",
          "AO/TO Total Effort Days",
          "AO/TO TC",
          "AO/TO E%",
          "AO/TO C%",
          "PMO Total Effort Days",
          "PMO TC",
          "PMO E%",
          "PMO C%",
        ];

        // Prepare SET clauses and parameter list
        const setClauses = [];
        const params = [];
        for (const col of cols) {
          // map JS key to SQL column name (camelCase to column)
          // e.g. totalOngoingCosts → 'Total Ongoing Costs'
          // assume your client property names match camel-cased versions of these
          const jsKey = col
            .replace(/ /g, "") // remove non-breaking spaces
            .replace(/\/TO/g, "AOTO") // AO/TO → aoto
            .replace(/ /g, "") // remove spaces
            .replace(/-/g, "") // remove hyphens
            .replace(/%/g, "Percent") // E% → EPercent, C% → CPercent
            .replace(/^ETBA/, "etBA")
            .replace(/^ETDev/, "etDev")
            .replace(/^ETQA/, "etQA")
            .replace(/^AOTO/, "aoto")
            .replace(/^PMO/, "pmo")
            .replace(/TotalEffortDays$/, "TotalEffortDays")
            .replace(/TC$/, "TC")
            .replace(/EPercent$/, "EPercent")
            .replace(/CPercent$/, "CPercent")
            .replace(/LOBSubTotal$/, "lobSubTotal")
            .replace(/TotalOngoingCosts$/, "totalOngoingCosts")
            .replace(/Contingency$/, "contingency")
            .replace(/^IntakeName$/, "intakeName");

          // Did the client send this field?
          if (updates[jsKey] !== undefined) {
            setClauses.push(`"${col}" = ?`);
            params.push(updates[jsKey]);
          } else {
            // keep existing value
            setClauses.push(`"${col}" = ?`);
            params.push(existing[col]);
          }
        }

        // If nothing to change, just return success
        if (setClauses.length === 0) {
          return res.json({ success: true, message: "No changes submitted." });
        }

        // 3) Update the metrics table
        const sql = `
          UPDATE metrics
             SET ${setClauses.join(", ")}
           WHERE "Intake ID" = ?
        `;
        params.push(entId);

        db.run(sql, params, function (err2) {
          if (err2) return res.status(500).json({ error: err2.message });

          // 4) If approvedDate was updated, propagate to jrm
          if (updates.approvedDate !== undefined) {
            db.run(
              `UPDATE jrm SET "Approved Date" = ? WHERE "Intake ID" = ?`,
              [updates.approvedDate, entId],
              function (err3) {
                if (err3) {
                  console.error(
                    "Failed to update jrm approved date:",
                    err3.message
                  );
                  // Metrics update succeeded; warn about jrm
                  return res.status(200).json({
                    success: true,
                    changes: this.changes,
                    warning:
                      "Metrics updated but failed to update JRM approved date",
                  });
                }
                res.json({
                  success: true,
                  changes: this.changes,
                  approvedDate: updates.approvedDate,
                });
              }
            );
          } else {
            // no approvedDate change
            res.json({ success: true, changes: this.changes });
          }
        });
      }
    );
  });
});

/**
 * Delete (remove) a metric row
 * DELETE /metrics/:intakeId
 */
app.delete("/metrics/:intakeId", (req, res) => {
  const id = req.params.intakeId;
  db.run(`DELETE FROM metrics WHERE "Intake ID" = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "Not found" });
    res.json({ deleted: id });
  });
});

// ——————————————————————————————————————————
// Start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
