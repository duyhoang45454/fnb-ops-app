const express = require('express');
const { AppError, query, withTransaction, getCurrentShift, insertAuditLog } = require('../db');
const { authenticate, getClientIp } = require('../auth');

const router = express.Router();

const STORE_LAT = parseFloat(process.env.STORE_LAT || '10.9032');
const STORE_LNG = parseFloat(process.env.STORE_LNG || '106.7681');
const MAX_DISTANCE_METERS = 150;

function getAllowedBssids() {
  const raw = process.env.ALLOWED_BSSIDS || '8C:3B:AD:12:9F';
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

router.use(authenticate);

router.get('/attendance', async (req, res, next) => {
  try {
    const { rows: shiftRows } = await query(
      `SELECT id FROM work_shifts ORDER BY opened_at DESC LIMIT 1`
    );
    if (!shiftRows.length) {
      return res.json([]);
    }
    const shiftId = shiftRows[0].id;

    const { rows } = await query(
      `SELECT a.id, a.user_id, u.full_name, r.code AS role,
              a.clock_in_at, a.clock_out_at, a.wifi_bssid, a.gps_lat, a.gps_lng
       FROM attendance_logs a
       JOIN users u ON u.id = a.user_id
       JOIN roles r ON r.id = u.role_id
       WHERE a.shift_id = $1
       ORDER BY a.clock_in_at DESC, a.id DESC`,
      [shiftId]
    );

    const result = rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      full_name: r.full_name,
      role: r.role,
      clock_in_at: r.clock_in_at,
      clock_out_at: r.clock_out_at,
      wifi_bssid: r.wifi_bssid,
      gps_lat: r.gps_lat,
      gps_lng: r.gps_lng,
      is_valid: true,
    }));

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post('/clock-in', async (req, res, next) => {
  try {
    const wifiBssid = typeof req.body?.wifi_bssid === 'string' ? req.body.wifi_bssid.trim() : '';
    const gpsLat = req.body?.gps_lat;
    const gpsLng = req.body?.gps_lng;
    const facePhotoUrl = typeof req.body?.face_photo_url === 'string'
      ? req.body.face_photo_url.trim()
      : '';

    const allowedBssids = getAllowedBssids();
    if (!wifiBssid || !allowedBssids.includes(wifiBssid.toUpperCase())) {
      throw new AppError(
        422,
        'ATTENDANCE_REJECTED',
        `Wi-Fi BSSID "${wifiBssid || 'trống'}" không khớp mạng nội bộ của quán.`
      );
    }

    if (typeof gpsLat !== 'number' || !Number.isFinite(gpsLat) || typeof gpsLng !== 'number' || !Number.isFinite(gpsLng)) {
      throw new AppError(422, 'ATTENDANCE_REJECTED', 'Tọa độ GPS không hợp lệ.');
    }

    const distance = haversineMeters(STORE_LAT, STORE_LNG, gpsLat, gpsLng);
    if (distance > MAX_DISTANCE_METERS) {
      throw new AppError(
        422,
        'ATTENDANCE_REJECTED',
        `Vị trí GPS cách quán ${Math.round(distance)}m (vượt quá giới hạn ${MAX_DISTANCE_METERS}m).`
      );
    }

    if (!facePhotoUrl) {
      throw new AppError(422, 'ATTENDANCE_REJECTED', 'Bắt buộc có ảnh chụp gương mặt (face_photo_url).');
    }

    const created = await withTransaction(async (client) => {
      const shift = await getCurrentShift(client, { forUpdate: false });
      const { rows: openRows } = await client.query(
        `SELECT id FROM attendance_logs
         WHERE shift_id = $1 AND user_id = $2 AND clock_out_at IS NULL
         FOR UPDATE`,
        [shift.id, req.user.id]
      );
      if (openRows.length) {
        throw new AppError(409, 'CONFLICT', 'Bạn đã chấm công vào ca hiện tại và chưa clock-out.');
      }

      const { rows: inserted } = await client.query(
        `INSERT INTO attendance_logs (
           user_id, shift_id, clock_in_at, wifi_bssid, gps_lat, gps_lng, face_photo_url
         ) VALUES ($1, $2, NOW(), $3, $4, $5, $6)
         RETURNING id, user_id, clock_in_at, clock_out_at, wifi_bssid, gps_lat, gps_lng`,
        [req.user.id, shift.id, wifiBssid, gpsLat, gpsLng, facePhotoUrl]
      );
      const row = inserted[0];

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'HR_CLOCK_IN',
        entityTable: 'attendance_logs',
        entityId: row.id,
        newValues: {
          shift_id: shift.id,
          wifi_bssid: wifiBssid,
          gps_lat: gpsLat,
          gps_lng: gpsLng,
          distance_m: Math.round(distance),
        },
        reason: `Chấm công vào ca (${wifiBssid}, cách quán ${Math.round(distance)}m)`,
        deviceIp: getClientIp(req),
      });

      return {
        id: row.id,
        user_id: row.user_id,
        full_name: req.user.full_name,
        role: req.user.role,
        clock_in_at: row.clock_in_at,
        clock_out_at: row.clock_out_at,
        wifi_bssid: row.wifi_bssid,
        gps_lat: row.gps_lat,
        gps_lng: row.gps_lng,
        is_valid: true,
      };
    });

    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
});

router.post('/clock-out', async (req, res, next) => {
  try {
    const updated = await withTransaction(async (client) => {
      const { rows: openRows } = await client.query(
        `SELECT id, shift_id, clock_in_at, wifi_bssid, gps_lat, gps_lng
         FROM attendance_logs
         WHERE user_id = $1 AND clock_out_at IS NULL
         ORDER BY clock_in_at DESC
         LIMIT 1
         FOR UPDATE`,
        [req.user.id]
      );
      if (!openRows.length) {
        throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy phiên chấm công đang mở để clock-out.');
      }

      const { rows: outRows } = await client.query(
        `UPDATE attendance_logs
         SET clock_out_at = NOW()
         WHERE id = $1
         RETURNING id, user_id, clock_in_at, clock_out_at, wifi_bssid, gps_lat, gps_lng`,
        [openRows[0].id]
      );
      const row = outRows[0];

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'HR_CLOCK_OUT',
        entityTable: 'attendance_logs',
        entityId: row.id,
        newValues: { clock_out_at: row.clock_out_at },
        reason: 'Chấm công ra ca (clock-out)',
        deviceIp: getClientIp(req),
      });

      return {
        id: row.id,
        user_id: row.user_id,
        full_name: req.user.full_name,
        role: req.user.role,
        clock_in_at: row.clock_in_at,
        clock_out_at: row.clock_out_at,
        wifi_bssid: row.wifi_bssid,
        gps_lat: row.gps_lat,
        gps_lng: row.gps_lng,
        is_valid: true,
      };
    });

    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
