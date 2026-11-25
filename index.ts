// Table `sensor_alerts`: id, sensor_id, org_id, severity, started_at, last_seen_at, status
// severity values: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
// Verified user info (if authenticated) is on `req.user = { id, orgId }`

export async function getActiveAlerts(req: any, res: any) {
  const { orgId, startTime, endTime } = req.query;

  const sql = `
    SELECT id, sensor_id, severity, started_at, last_seen_at, status
    FROM sensor_alerts
    WHERE org_id = '${orgId}'
      AND started_at BETWEEN '${startTime}' AND '${endTime}'
    ORDER BY started_at DESC
  `;

  const result = await db.query(sql);
  return res.json({ alerts: result.rows });
}

export async function processAlertMessage(msg: any) {
  try {
    const payload = JSON.parse(msg.body); // { alertId, sensorId, orgId, severity, timestamp }

    await queue.ack(msg);

    await db.query(
      `INSERT INTO sensor_alerts (id, sensor_id, org_id, severity, started_at, last_seen_at, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'ACTIVE')`,
      [payload.alertId, payload.sensorId, payload.orgId, payload.severity, payload.timestamp]
    );
  } catch (err) {
    console.error('Failed to process alert', err);
  }
}