-- 2.14 Keycard requests and the keycard register.
-- A department manager asks for a staff keycard (new or replacement) or for its cancellation (resignation, lost,
-- damaged). Front office / security issues it (encoded at an encoder from the portal or at the Visionline desk),
-- records its return and cancels it in Visionline (a returned card is overwritten with a card that expires a minute
-- later; a lost card is cancelled by its number). HR and the security manager are told by e-mail.
CREATE TABLE IF NOT EXISTS keycard_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id        uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  number          text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('new', 'replacement', 'cancel')),
  staff_type      text NOT NULL CHECK (staff_type IN ('permanent', 'daily')),
  status          text NOT NULL CHECK (status IN ('SUBMITTED', 'ISSUED', 'REJECTED', 'COLLECTED', 'CANCELLED', 'WITHDRAWN')),
  given_name      text CHECK (length(given_name) <= 60),
  surname         text CHECK (length(surname) <= 60),
  department      text CHECK (length(department) <= 80),
  job_title       text CHECK (length(job_title) <= 80),
  employee_no     text CHECK (length(employee_no) <= 40),
  card_label      text CHECK (length(card_label) <= 20),          -- the hotel's own card number, e.g. "HK 001"
  quantity        int NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 50),
  issued_count    int NOT NULL DEFAULT 0,
  user_group      text,                                            -- Visionline user group of the holder
  template_id     uuid REFERENCES access_templates(id) ON DELETE SET NULL,
  doors           text[] NOT NULL DEFAULT '{}',
  valid_until     timestamptz,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 2 AND 300),
  manager_name    text NOT NULL CHECK (length(manager_name) BETWEEN 2 AND 80),
  hr_email        text CHECK (hr_email IS NULL OR hr_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  note            text CHECK (length(note) <= 500),
  source          text NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'qr')),
  vl_user_id      text,
  card_reg_no     text,
  issue_method    text CHECK (issue_method IN ('encoder', 'visionline_desk')),
  return_state    text CHECK (return_state IN ('returned', 'lost', 'damaged', 'not_returned')),
  cancel_method   text CHECK (cancel_method IN ('expire_now', 'cancel_card', 'visionline_desk')),
  command_id      uuid,
  related_id      uuid REFERENCES keycard_requests(id) ON DELETE SET NULL,
  requested_by    uuid REFERENCES operators(id) ON DELETE SET NULL,
  handled_by      uuid REFERENCES operators(id) ON DELETE SET NULL,
  history         jsonb NOT NULL DEFAULT '[]',
  notified        jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, number)
);
CREATE INDEX IF NOT EXISTS keycard_requests_status_idx ON keycard_requests (hotel_id, status, created_at DESC);

-- One row per card the hotel numbers itself (HK 001 ...): who holds it now and what happened to it.
CREATE TABLE IF NOT EXISTS keycard_register (
  hotel_id     uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  label        text NOT NULL,
  department   text,
  staff_type   text NOT NULL DEFAULT 'permanent' CHECK (staff_type IN ('permanent', 'daily')),
  holder_name  text,
  vl_user_id   text,
  card_reg_no  text,
  status       text NOT NULL CHECK (status IN ('in_use', 'returned', 'lost', 'damaged', 'cancelled')),
  request_id   uuid REFERENCES keycard_requests(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, label)
);

-- Emergency door commands (open / stand open / back to normal) sent to online locks, in batches.
CREATE TABLE IF NOT EXISTS emergency_door_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  emergency_id uuid REFERENCES emergencies(id) ON DELETE SET NULL,
  command      text NOT NULL,
  doors        text[] NOT NULL,
  skipped      text[] NOT NULL DEFAULT '{}',   -- offline doors: no command possible
  command_ids  uuid[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Encoders read from Visionline [Web API §5.14] are kept with the other resources.
ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_kind_check;
ALTER TABLE resources ADD CONSTRAINT resources_kind_check CHECK (kind IN ('door','doorgroup','usergroup','timeschedule','mobileaccessaccount','encoder'));

-- Unpaid-guest lock-outs (front office asks, a manager approves, the lock is reached by checkout or a 1-minute card).
CREATE TABLE IF NOT EXISTS guest_lockouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room         text NOT NULL CHECK (length(room) BETWEEN 1 AND 20),
  guest_name   text CHECK (length(guest_name) <= 120),
  amount       text CHECK (length(amount) <= 40),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  status       text NOT NULL CHECK (status IN ('REQUESTED','APPROVED','REJECTED','DONE','RESTORED','FAILED')),
  method       text CHECK (method IN ('checkout_online','card_offline')),
  door_online  boolean,
  command_id   uuid,
  requested_by uuid REFERENCES operators(id) ON DELETE SET NULL,
  approved_by  uuid REFERENCES operators(id) ON DELETE SET NULL,
  done_by      uuid REFERENCES operators(id) ON DELETE SET NULL,
  note         text CHECK (length(note) <= 300),
  history      jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guest_lockouts_idx ON guest_lockouts (hotel_id, created_at DESC);

-- Departures: after the PMS (Opera) checkout, confirm the room's lock no longer accepts the guest's cards: a checkout
-- command for online locks, a clearance card placed by staff for offline locks.
CREATE TABLE IF NOT EXISTS departure_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  day         date NOT NULL,
  room        text NOT NULL,
  online      boolean,
  status      text NOT NULL CHECK (status IN ('SENT','REACHED','FAILED','CLEARED')),
  command_id  uuid,
  done_by     uuid REFERENCES operators(id) ON DELETE SET NULL,
  done_at     timestamptz,
  UNIQUE (hotel_id, day, room)
);

-- Valid guest keycards per room, read from Visionline before the Accounts report.
CREATE TABLE IF NOT EXISTS guest_card_counts (
  hotel_id  uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room      text NOT NULL,
  n         int NOT NULL,
  read_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, room)
);
