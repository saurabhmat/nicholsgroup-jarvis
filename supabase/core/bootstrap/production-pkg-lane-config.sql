-- One-time PRODUCTION step 2 for the Pub K Group lane (run by Saurabh in the Supabase SQL editor of project
-- lxjhaxdkqtmkhloqaffb, AFTER production-pkg.sql). Agents never run this. Safe to run twice (it only inserts version 1
-- when the lane has no lane_config yet).
--
-- Why: the setup interview, the Google connect (Settings -> Connections) and the assistant's connection facts all read
-- core.lane_config for the lane. Without a row the interview answers 403 and Google refuses to connect.
-- Settings only: no vendor ids, no secrets (QuickBooks, Stripe, GoHighLevel are added later through lane_config).
--
-- Before running: the mailbox below is the Pub K Group mailbox you will connect to Google. It must be the exact primary
-- address of that Google account. Do NOT use a personal or SimpliAutomated mailbox here (D-33).
begin;

insert into core.lane_config (lane_id, version, config)
select 'PKG', 1, jsonb_build_object(
  'enabled_modules', jsonb_build_array('assistant', 'comms', 'calendar', 'brain'),
  'mailboxes',       jsonb_build_array('saurabh@pub-k.org'),
  'mail_transport',  'native'
)
where not exists (select 1 from core.lane_config where lane_id = 'PKG');

-- Check: one row, version 1, the mailbox listed.
select lane_id, version, config from core.lane_config_current where lane_id = 'PKG';

commit;
