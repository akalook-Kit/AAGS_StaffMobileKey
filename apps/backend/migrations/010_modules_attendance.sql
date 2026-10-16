-- 2.8: hide portal modules from people, and Time & attendance.

-- Modules hidden from one person in one hotel (Operators page). Hiding removes the module's permissions too.
CREATE TABLE IF NOT EXISTS operator_module_access (
  operator_id    uuid NOT NULL REFERENCES operators(id),
  hotel_id       uuid NOT NULL REFERENCES hotels(id),
  hidden_modules text[] NOT NULL DEFAULT '{}',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, hotel_id)
);

-- Shifts: planned working times. A shift that ends before it starts runs past midnight.
CREATE TABLE IF NOT EXISTS ta_shifts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id       uuid NOT NULL REFERENCES hotels(id),
  name           text NOT NULL,
  start_time     text NOT NULL CHECK (start_time ~ '^\d{2}:\d{2}$'),
  end_time       text NOT NULL CHECK (end_time ~ '^\d{2}:\d{2}$'),
  break_minutes  int NOT NULL DEFAULT 60 CHECK (break_minutes BETWEEN 0 AND 600),
  grace_minutes  int NOT NULL DEFAULT 10 CHECK (grace_minutes BETWEEN 0 AND 240),
  work_days      int[] NOT NULL DEFAULT '{1,2,3,4,5,6}',   -- ISO weekdays, 1 = Monday
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, name)
);

-- People whose time is recorded: platform staff, Visionline keycard holders, and people without a card (daily workers).
CREATE TABLE IF NOT EXISTS ta_people (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      uuid NOT NULL REFERENCES hotels(id),
  kind          text NOT NULL CHECK (kind IN ('staff', 'keycard', 'manual')),
  staff_id      uuid REFERENCES staff(id),
  vl_user_id    text,                          -- Visionline user id (keycard holder)
  full_name     text NOT NULL,
  employee_no   text,                          -- payroll number
  department    text,
  job_title     text,
  employment    text NOT NULL DEFAULT 'permanent' CHECK (employment IN ('permanent', 'contract', 'casual', 'intern')),
  pay_basis     text NOT NULL DEFAULT 'monthly' CHECK (pay_basis IN ('monthly', 'daily', 'hourly')),
  shift_id      uuid REFERENCES ta_shifts(id) ON DELETE SET NULL,
  active        boolean NOT NULL DEFAULT true,
  start_date    date,
  end_date      date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ta_people_staff_uq ON ta_people (hotel_id, staff_id) WHERE staff_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ta_people_vl_uq ON ta_people (hotel_id, vl_user_id) WHERE vl_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ta_people_empno_uq ON ta_people (hotel_id, lower(employee_no)) WHERE employee_no IS NOT NULL;

-- Clock records: from attendance doors (keycards and mobile keys), the check-in desk, or entered by HR.
CREATE TABLE IF NOT EXISTS ta_punches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id),
  person_id    uuid NOT NULL REFERENCES ta_people(id),
  at           timestamptz NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('in', 'out', 'auto')),
  source       text NOT NULL CHECK (source IN ('door', 'desk', 'hr')),
  door_id      text,
  event_ref    text UNIQUE,                    -- visionline_events / audit row it came from (no duplicates)
  entered_by   uuid REFERENCES operators(id),
  reason       text,
  voided_at    timestamptz,
  voided_by    uuid REFERENCES operators(id),
  void_reason  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ta_punches_person_idx ON ta_punches (hotel_id, person_id, at);

-- Leave, days off and public holidays (person NULL = everybody).
CREATE TABLE IF NOT EXISTS ta_absences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL REFERENCES hotels(id),
  person_id   uuid REFERENCES ta_people(id),
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('annual_leave', 'sick', 'day_off', 'public_holiday', 'unpaid', 'other')),
  note        text,
  created_by  uuid REFERENCES operators(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from)
);
CREATE INDEX IF NOT EXISTS ta_absences_idx ON ta_absences (hotel_id, date_from, date_to);

-- Approved (locked) periods: sent to payroll, no more changes.
CREATE TABLE IF NOT EXISTS ta_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL REFERENCES hotels(id),
  date_from    date NOT NULL,
  date_to      date NOT NULL,
  approved_by  uuid REFERENCES operators(id),
  approved_at  timestamptz NOT NULL DEFAULT now(),
  note         text,
  CHECK (date_to >= date_from)
);
CREATE INDEX IF NOT EXISTS ta_periods_idx ON ta_periods (hotel_id, date_from, date_to);
