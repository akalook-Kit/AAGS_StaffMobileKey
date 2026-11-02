-- 2.19 (Armel, 27 Oct): 3-4.8 V locks are critical at 3.6 V. Sites that never set a threshold for these locks get it as a
-- new version of their policy (Settings -> Battery & maintenance keeps the history and can change it).
INSERT INTO hotel_config_versions (hotel_id, kind, version, data, created_by)
SELECT v.hotel_id, v.kind, v.version + 1,
       jsonb_set(v.data, '{battery,voltage,lowRange}', '{"low": null, "critical": 3.6}'::jsonb, true), NULL
FROM (SELECT DISTINCT ON (hotel_id) hotel_id, kind, version, data FROM hotel_config_versions WHERE kind='policy' ORDER BY hotel_id, version DESC) v
WHERE v.data ? 'battery' AND v.data->'battery' ? 'voltage'
  AND COALESCE(v.data#>>'{battery,voltage,lowRange,low}', 'null') = 'null'
  AND COALESCE(v.data#>>'{battery,voltage,lowRange,critical}', 'null') = 'null';
