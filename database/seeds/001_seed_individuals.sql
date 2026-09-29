-- Seed data for consumer (individuals) domain: 100 users across 4 plans (free, plus, pro, ultra)
BEGIN;

CREATE SCHEMA IF NOT EXISTS consumer;

-- User 1: Aarav Ganguly (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('aarav.ganguly', 'aarav.ganguly@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer1$hash', 'Aarav Ganguly', 'active', now() - interval '100 day', now() - interval '0 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'aarav.ganguly', 'password', now() - interval '100 day', now() - interval '0 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 2: Aditi Kapoor (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('aditi.kapoor', 'aditi.kapoor@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer2$hash', 'Aditi Kapoor', 'active', now() - interval '99 day', now() - interval '1 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'aditi.kapoor', 'password', now() - interval '99 day', now() - interval '1 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 3: Alexander Mehta (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('alexander.mehta', 'alexander.mehta@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer3$hash', 'Alexander Mehta', 'active', now() - interval '98 day', now() - interval '2 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'alexander.mehta', 'password', now() - interval '98 day', now() - interval '2 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 4: Amara Nair (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('amara.nair', 'amara.nair@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer4$hash', 'Amara Nair', 'active', now() - interval '97 day', now() - interval '3 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'amara.nair', 'password', now() - interval '97 day', now() - interval '3 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 5: Ananya Roy (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('ananya.roy', 'ananya.roy@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer5$hash', 'Ananya Roy', 'active', now() - interval '96 day', now() - interval '4 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'ananya.roy', 'password', now() - interval '96 day', now() - interval '4 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 6: Arthur Sharma (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('arthur.sharma', 'arthur.sharma@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer6$hash', 'Arthur Sharma', 'active', now() - interval '95 day', now() - interval '5 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'arthur.sharma', 'password', now() - interval '95 day', now() - interval '5 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 7: Beatrix Johnson (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('beatrix.johnson', 'beatrix.johnson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer7$hash', 'Beatrix Johnson', 'active', now() - interval '94 day', now() - interval '6 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'beatrix.johnson', 'password', now() - interval '94 day', now() - interval '6 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 8: Benjamin Jones (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('benjamin.jones', 'benjamin.jones@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer8$hash', 'Benjamin Jones', 'active', now() - interval '93 day', now() - interval '7 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'benjamin.jones', 'password', now() - interval '93 day', now() - interval '7 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 9: Bhavna Davis (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('bhavna.davis', 'bhavna.davis@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer9$hash', 'Bhavna Davis', 'active', now() - interval '92 day', now() - interval '8 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'bhavna.davis', 'password', now() - interval '92 day', now() - interval '8 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 10: Caleb Hernandez (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('caleb.hernandez', 'caleb.hernandez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer10$hash', 'Caleb Hernandez', 'active', now() - interval '91 day', now() - interval '9 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'caleb.hernandez', 'password', now() - interval '91 day', now() - interval '9 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 11: Camilla Wilson (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('camilla.wilson', 'camilla.wilson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer11$hash', 'Camilla Wilson', 'active', now() - interval '90 day', now() - interval '10 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'camilla.wilson', 'password', now() - interval '90 day', now() - interval '10 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 12: Chloe Taylor (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('chloe.taylor', 'chloe.taylor@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer12$hash', 'Chloe Taylor', 'active', now() - interval '89 day', now() - interval '11 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'chloe.taylor', 'password', now() - interval '89 day', now() - interval '11 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 13: Daniel Martin (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('daniel.martin', 'daniel.martin@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer13$hash', 'Daniel Martin', 'active', now() - interval '88 day', now() - interval '12 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'daniel.martin', 'password', now() - interval '88 day', now() - interval '12 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 14: Dev Thompson (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('dev.thompson', 'dev.thompson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer14$hash', 'Dev Thompson', 'active', now() - interval '87 day', now() - interval '13 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'dev.thompson', 'password', now() - interval '87 day', now() - interval '13 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 15: Eleanor Sanchez (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('eleanor.sanchez', 'eleanor.sanchez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer15$hash', 'Eleanor Sanchez', 'active', now() - interval '86 day', now() - interval '14 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'eleanor.sanchez', 'password', now() - interval '86 day', now() - interval '14 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 16: Ethan Lewis (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('ethan.lewis', 'ethan.lewis@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer16$hash', 'Ethan Lewis', 'active', now() - interval '85 day', now() - interval '15 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'ethan.lewis', 'password', now() - interval '85 day', now() - interval '15 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 17: Fatima Young (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('fatima.young', 'fatima.young@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer17$hash', 'Fatima Young', 'active', now() - interval '84 day', now() - interval '16 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'fatima.young', 'password', now() - interval '84 day', now() - interval '16 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 18: Felix Chatterjee (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('felix.chatterjee', 'felix.chatterjee@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer18$hash', 'Felix Chatterjee', 'active', now() - interval '83 day', now() - interval '17 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'felix.chatterjee', 'password', now() - interval '83 day', now() - interval '17 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 19: Gabriel Dey (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('gabriel.dey', 'gabriel.dey@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer19$hash', 'Gabriel Dey', 'active', now() - interval '82 day', now() - interval '18 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'gabriel.dey', 'password', now() - interval '82 day', now() - interval '18 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 20: Gauri Ghosh (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('gauri.ghosh', 'gauri.ghosh@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer20$hash', 'Gauri Ghosh', 'active', now() - interval '81 day', now() - interval '19 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'gauri.ghosh', 'password', now() - interval '81 day', now() - interval '19 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 21: Grace Kulkarni (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('grace.kulkarni', 'grace.kulkarni@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer21$hash', 'Grace Kulkarni', 'active', now() - interval '80 day', now() - interval '20 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'grace.kulkarni', 'password', now() - interval '80 day', now() - interval '0 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 22: Hannah Mitra (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('hannah.mitra', 'hannah.mitra@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer22$hash', 'Hannah Mitra', 'active', now() - interval '79 day', now() - interval '21 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'hannah.mitra', 'password', now() - interval '79 day', now() - interval '1 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 23: Harsh Patel (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('harsh.patel', 'harsh.patel@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer23$hash', 'Harsh Patel', 'active', now() - interval '78 day', now() - interval '22 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'harsh.patel', 'password', now() - interval '78 day', now() - interval '2 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 24: Henry Saha (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('henry.saha', 'henry.saha@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer24$hash', 'Henry Saha', 'active', now() - interval '77 day', now() - interval '23 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'henry.saha', 'password', now() - interval '77 day', now() - interval '3 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 25: Ishaan Singh (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('ishaan.singh', 'ishaan.singh@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer25$hash', 'Ishaan Singh', 'active', now() - interval '76 day', now() - interval '24 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'ishaan.singh', 'password', now() - interval '76 day', now() - interval '4 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 26: Isla Williams (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('isla.williams', 'isla.williams@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer26$hash', 'Isla Williams', 'active', now() - interval '75 day', now() - interval '25 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'isla.williams', 'password', now() - interval '75 day', now() - interval '5 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 27: Jacob Garcia (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('jacob.garcia', 'jacob.garcia@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer27$hash', 'Jacob Garcia', 'active', now() - interval '74 day', now() - interval '26 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'jacob.garcia', 'password', now() - interval '74 day', now() - interval '6 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 28: Jasmine Rodriguez (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('jasmine.rodriguez', 'jasmine.rodriguez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer28$hash', 'Jasmine Rodriguez', 'active', now() - interval '73 day', now() - interval '27 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'jasmine.rodriguez', 'password', now() - interval '73 day', now() - interval '7 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 29: Jasper Lopez (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('jasper.lopez', 'jasper.lopez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer29$hash', 'Jasper Lopez', 'active', now() - interval '72 day', now() - interval '28 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'jasper.lopez', 'password', now() - interval '72 day', now() - interval '8 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 30: Kabir Anderson (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('kabir.anderson', 'kabir.anderson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer30$hash', 'Kabir Anderson', 'active', now() - interval '71 day', now() - interval '29 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'kabir.anderson', 'password', now() - interval '71 day', now() - interval '9 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 31: Kavya Moore (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('kavya.moore', 'kavya.moore@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer31$hash', 'Kavya Moore', 'active', now() - interval '70 day', now() - interval '30 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'kavya.moore', 'password', now() - interval '70 day', now() - interval '10 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 32: Leo Lee (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('leo.lee', 'leo.lee@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer32$hash', 'Leo Lee', 'active', now() - interval '69 day', now() - interval '31 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'leo.lee', 'password', now() - interval '69 day', now() - interval '11 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 33: Liam White (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('liam.white', 'liam.white@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer33$hash', 'Liam White', 'active', now() - interval '68 day', now() - interval '32 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'liam.white', 'password', now() - interval '68 day', now() - interval '12 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 34: Lucas Clark (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('lucas.clark', 'lucas.clark@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer34$hash', 'Lucas Clark', 'active', now() - interval '67 day', now() - interval '33 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'lucas.clark', 'password', now() - interval '67 day', now() - interval '13 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 35: Madhav Robinson (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('madhav.robinson', 'madhav.robinson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer35$hash', 'Madhav Robinson', 'active', now() - interval '66 day', now() - interval '34 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'madhav.robinson', 'password', now() - interval '66 day', now() - interval '14 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 36: Maya Banerjee (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('maya.banerjee', 'maya.banerjee@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer36$hash', 'Maya Banerjee', 'active', now() - interval '65 day', now() - interval '35 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'maya.banerjee', 'password', now() - interval '65 day', now() - interval '15 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 37: Meera Choudhury (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('meera.choudhury', 'meera.choudhury@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer37$hash', 'Meera Choudhury', 'active', now() - interval '64 day', now() - interval '36 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'meera.choudhury', 'password', now() - interval '64 day', now() - interval '16 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 38: Milo Dutta (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('milo.dutta', 'milo.dutta@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer38$hash', 'Milo Dutta', 'active', now() - interval '63 day', now() - interval '37 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'milo.dutta', 'password', now() - interval '63 day', now() - interval '17 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 39: Nathan Gupta (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('nathan.gupta', 'nathan.gupta@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer39$hash', 'Nathan Gupta', 'active', now() - interval '62 day', now() - interval '38 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'nathan.gupta', 'password', now() - interval '62 day', now() - interval '18 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 40: Neha Majumdar (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('neha.majumdar', 'neha.majumdar@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer40$hash', 'Neha Majumdar', 'active', now() - interval '61 day', now() - interval '39 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'neha.majumdar', 'password', now() - interval '61 day', now() - interval '19 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 41: Nikhil Mukherjee (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('nikhil.mukherjee', 'nikhil.mukherjee@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer41$hash', 'Nikhil Mukherjee', 'active', now() - interval '60 day', now() - interval '40 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'nikhil.mukherjee', 'password', now() - interval '60 day', now() - interval '0 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 42: Noah Reddy (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('noah.reddy', 'noah.reddy@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer42$hash', 'Noah Reddy', 'active', now() - interval '59 day', now() - interval '41 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'noah.reddy', 'password', now() - interval '59 day', now() - interval '1 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 43: Oliver Sen (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('oliver.sen', 'oliver.sen@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer43$hash', 'Oliver Sen', 'active', now() - interval '58 day', now() - interval '42 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'oliver.sen', 'password', now() - interval '58 day', now() - interval '2 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 44: Olivia Smith (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('olivia.smith', 'olivia.smith@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer44$hash', 'Olivia Smith', 'active', now() - interval '57 day', now() - interval '43 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'olivia.smith', 'password', now() - interval '57 day', now() - interval '3 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 45: Penelope Brown (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('penelope.brown', 'penelope.brown@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer45$hash', 'Penelope Brown', 'active', now() - interval '56 day', now() - interval '44 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'penelope.brown', 'password', now() - interval '56 day', now() - interval '4 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 46: Pooja Miller (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('pooja.miller', 'pooja.miller@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer46$hash', 'Pooja Miller', 'active', now() - interval '55 day', now() - interval '45 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'pooja.miller', 'password', now() - interval '55 day', now() - interval '5 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 47: Pranav Martinez (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('pranav.martinez', 'pranav.martinez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer47$hash', 'Pranav Martinez', 'active', now() - interval '54 day', now() - interval '46 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'pranav.martinez', 'password', now() - interval '54 day', now() - interval '6 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 48: Priya Gonzalez (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('priya.gonzalez', 'priya.gonzalez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer48$hash', 'Priya Gonzalez', 'active', now() - interval '53 day', now() - interval '47 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'priya.gonzalez', 'password', now() - interval '53 day', now() - interval '7 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 49: Rahul Thomas (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('rahul.thomas', 'rahul.thomas@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer49$hash', 'Rahul Thomas', 'active', now() - interval '52 day', now() - interval '48 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'rahul.thomas', 'password', now() - interval '52 day', now() - interval '8 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 50: Rhea Jackson (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('rhea.jackson', 'rhea.jackson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer50$hash', 'Rhea Jackson', 'active', now() - interval '51 day', now() - interval '49 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'rhea.jackson', 'password', now() - interval '51 day', now() - interval '9 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 51: Rohan Perez (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('rohan.perez', 'rohan.perez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer51$hash', 'Rohan Perez', 'active', now() - interval '50 day', now() - interval '50 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'rohan.perez', 'password', now() - interval '50 day', now() - interval '10 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 52: Rowan Harris (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('rowan.harris', 'rowan.harris@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer52$hash', 'Rowan Harris', 'active', now() - interval '49 day', now() - interval '51 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'rowan.harris', 'password', now() - interval '49 day', now() - interval '11 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 53: Samarth Ramirez (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('samarth.ramirez', 'samarth.ramirez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer53$hash', 'Samarth Ramirez', 'active', now() - interval '48 day', now() - interval '52 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'samarth.ramirez', 'password', now() - interval '48 day', now() - interval '12 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 54: Sara Walker (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('sara.walker', 'sara.walker@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer54$hash', 'Sara Walker', 'active', now() - interval '47 day', now() - interval '53 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'sara.walker', 'password', now() - interval '47 day', now() - interval '13 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 55: Sebastian Bose (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('sebastian.bose', 'sebastian.bose@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer55$hash', 'Sebastian Bose', 'active', now() - interval '46 day', now() - interval '54 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'sebastian.bose', 'password', now() - interval '46 day', now() - interval '14 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 56: Shreya Das (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('shreya.das', 'shreya.das@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer56$hash', 'Shreya Das', 'active', now() - interval '45 day', now() - interval '55 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'shreya.das', 'password', now() - interval '45 day', now() - interval '15 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 57: Siddharth Ganguly (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('siddharth.ganguly', 'siddharth.ganguly@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer57$hash', 'Siddharth Ganguly', 'active', now() - interval '44 day', now() - interval '56 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'siddharth.ganguly', 'password', now() - interval '44 day', now() - interval '16 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 58: Sophia Kapoor (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('sophia.kapoor', 'sophia.kapoor@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer58$hash', 'Sophia Kapoor', 'active', now() - interval '43 day', now() - interval '57 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'sophia.kapoor', 'password', now() - interval '43 day', now() - interval '17 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 59: Tanvi Mehta (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('tanvi.mehta', 'tanvi.mehta@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer59$hash', 'Tanvi Mehta', 'active', now() - interval '42 day', now() - interval '58 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'tanvi.mehta', 'password', now() - interval '42 day', now() - interval '18 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 60: Tara Nair (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('tara.nair', 'tara.nair@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer60$hash', 'Tara Nair', 'active', now() - interval '41 day', now() - interval '59 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'tara.nair', 'password', now() - interval '41 day', now() - interval '19 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 61: Thomas Roy (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('thomas.roy', 'thomas.roy@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer61$hash', 'Thomas Roy', 'active', now() - interval '40 day', now() - interval '60 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'thomas.roy', 'password', now() - interval '40 day', now() - interval '0 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 62: Uma Sharma (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('uma.sharma', 'uma.sharma@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer62$hash', 'Uma Sharma', 'active', now() - interval '39 day', now() - interval '61 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'uma.sharma', 'password', now() - interval '39 day', now() - interval '1 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 63: Varun Johnson (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('varun.johnson', 'varun.johnson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer63$hash', 'Varun Johnson', 'active', now() - interval '38 day', now() - interval '62 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'varun.johnson', 'password', now() - interval '38 day', now() - interval '2 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 64: Ved Jones (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('ved.jones', 'ved.jones@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer64$hash', 'Ved Jones', 'active', now() - interval '37 day', now() - interval '63 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'ved.jones', 'password', now() - interval '37 day', now() - interval '3 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 65: Victoria Davis (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('victoria.davis', 'victoria.davis@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer65$hash', 'Victoria Davis', 'active', now() - interval '36 day', now() - interval '64 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'victoria.davis', 'password', now() - interval '36 day', now() - interval '4 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 66: Vihaan Hernandez (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('vihaan.hernandez', 'vihaan.hernandez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer66$hash', 'Vihaan Hernandez', 'active', now() - interval '35 day', now() - interval '65 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'vihaan.hernandez', 'password', now() - interval '35 day', now() - interval '5 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 67: Vikram Wilson (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('vikram.wilson', 'vikram.wilson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer67$hash', 'Vikram Wilson', 'active', now() - interval '34 day', now() - interval '66 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'vikram.wilson', 'password', now() - interval '34 day', now() - interval '6 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 68: William Taylor (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('william.taylor', 'william.taylor@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer68$hash', 'William Taylor', 'active', now() - interval '33 day', now() - interval '67 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'william.taylor', 'password', now() - interval '33 day', now() - interval '7 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 69: Yash Martin (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('yash.martin', 'yash.martin@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer69$hash', 'Yash Martin', 'active', now() - interval '32 day', now() - interval '68 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'yash.martin', 'password', now() - interval '32 day', now() - interval '8 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 70: Zara Thompson (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('zara.thompson', 'zara.thompson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer70$hash', 'Zara Thompson', 'active', now() - interval '31 day', now() - interval '69 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'zara.thompson', 'password', now() - interval '31 day', now() - interval '9 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 71: Zoe Sanchez (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('zoe.sanchez', 'zoe.sanchez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer71$hash', 'Zoe Sanchez', 'active', now() - interval '30 day', now() - interval '70 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'zoe.sanchez', 'password', now() - interval '30 day', now() - interval '10 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 72: Aditya Lewis (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('aditya.lewis', 'aditya.lewis@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer72$hash', 'Aditya Lewis', 'active', now() - interval '29 day', now() - interval '71 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'aditya.lewis', 'password', now() - interval '29 day', now() - interval '11 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 73: Aria Young (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('aria.young', 'aria.young@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer73$hash', 'Aria Young', 'active', now() - interval '28 day', now() - interval '72 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'aria.young', 'password', now() - interval '28 day', now() - interval '12 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 74: Audrey Chatterjee (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('audrey.chatterjee', 'audrey.chatterjee@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer74$hash', 'Audrey Chatterjee', 'active', now() - interval '27 day', now() - interval '73 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'audrey.chatterjee', 'password', now() - interval '27 day', now() - interval '13 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 75: Avani Dey (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('avani.dey', 'avani.dey@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer75$hash', 'Avani Dey', 'active', now() - interval '26 day', now() - interval '74 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'avani.dey', 'password', now() - interval '26 day', now() - interval '14 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 76: Christian Ghosh (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('christian.ghosh', 'christian.ghosh@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer76$hash', 'Christian Ghosh', 'active', now() - interval '25 day', now() - interval '75 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'christian.ghosh', 'password', now() - interval '25 day', now() - interval '15 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 77: Clara Kulkarni (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('clara.kulkarni', 'clara.kulkarni@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer77$hash', 'Clara Kulkarni', 'active', now() - interval '24 day', now() - interval '76 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'clara.kulkarni', 'password', now() - interval '24 day', now() - interval '16 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 78: David Mitra (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('david.mitra', 'david.mitra@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer78$hash', 'David Mitra', 'active', now() - interval '23 day', now() - interval '77 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'david.mitra', 'password', now() - interval '23 day', now() - interval '17 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 79: Diya Patel (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('diya.patel', 'diya.patel@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer79$hash', 'Diya Patel', 'active', now() - interval '22 day', now() - interval '78 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'diya.patel', 'password', now() - interval '22 day', now() - interval '18 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 80: Elena Saha (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('elena.saha', 'elena.saha@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer80$hash', 'Elena Saha', 'active', now() - interval '21 day', now() - interval '79 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'elena.saha', 'password', now() - interval '21 day', now() - interval '19 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 81: Eva Singh (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('eva.singh', 'eva.singh@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer81$hash', 'Eva Singh', 'active', now() - interval '20 day', now() - interval '80 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'eva.singh', 'password', now() - interval '20 day', now() - interval '0 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 82: Freya Williams (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('freya.williams', 'freya.williams@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer82$hash', 'Freya Williams', 'active', now() - interval '19 day', now() - interval '81 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'freya.williams', 'password', now() - interval '19 day', now() - interval '1 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 83: Gia Garcia (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('gia.garcia', 'gia.garcia@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer83$hash', 'Gia Garcia', 'active', now() - interval '18 day', now() - interval '82 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'gia.garcia', 'password', now() - interval '18 day', now() - interval '2 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 84: Ira Rodriguez (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('ira.rodriguez', 'ira.rodriguez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer84$hash', 'Ira Rodriguez', 'active', now() - interval '17 day', now() - interval '83 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'ira.rodriguez', 'password', now() - interval '17 day', now() - interval '3 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 85: Julian Lopez (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('julian.lopez', 'julian.lopez@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer85$hash', 'Julian Lopez', 'active', now() - interval '16 day', now() - interval '84 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'julian.lopez', 'password', now() - interval '16 day', now() - interval '4 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 86: Kiara Anderson (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('kiara.anderson', 'kiara.anderson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer86$hash', 'Kiara Anderson', 'active', now() - interval '15 day', now() - interval '85 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'kiara.anderson', 'password', now() - interval '15 day', now() - interval '5 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 87: Kunal Moore (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('kunal.moore', 'kunal.moore@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer87$hash', 'Kunal Moore', 'active', now() - interval '14 day', now() - interval '86 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'kunal.moore', 'password', now() - interval '14 day', now() - interval '6 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 88: Leila Lee (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('leila.lee', 'leila.lee@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer88$hash', 'Leila Lee', 'active', now() - interval '13 day', now() - interval '87 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'leila.lee', 'password', now() - interval '13 day', now() - interval '7 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 89: Manish White (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('manish.white', 'manish.white@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer89$hash', 'Manish White', 'active', now() - interval '12 day', now() - interval '88 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'manish.white', 'password', now() - interval '12 day', now() - interval '8 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 90: Mira Clark (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('mira.clark', 'mira.clark@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer90$hash', 'Mira Clark', 'active', now() - interval '11 day', now() - interval '89 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'mira.clark', 'password', now() - interval '11 day', now() - interval '9 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 91: Neil Robinson (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('neil.robinson', 'neil.robinson@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer91$hash', 'Neil Robinson', 'active', now() - interval '10 day', now() - interval '90 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'neil.robinson', 'password', now() - interval '10 day', now() - interval '10 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 92: Nisha Banerjee (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('nisha.banerjee', 'nisha.banerjee@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer92$hash', 'Nisha Banerjee', 'active', now() - interval '9 day', now() - interval '91 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'nisha.banerjee', 'password', now() - interval '9 day', now() - interval '11 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 93: Oscar Choudhury (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('oscar.choudhury', 'oscar.choudhury@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer93$hash', 'Oscar Choudhury', 'active', now() - interval '8 day', now() - interval '92 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'oscar.choudhury', 'password', now() - interval '8 day', now() - interval '12 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 94: Rishi Dutta (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('rishi.dutta', 'rishi.dutta@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer94$hash', 'Rishi Dutta', 'active', now() - interval '7 day', now() - interval '93 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'rishi.dutta', 'password', now() - interval '7 day', now() - interval '13 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 95: Riya Gupta (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('riya.gupta', 'riya.gupta@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer95$hash', 'Riya Gupta', 'active', now() - interval '6 day', now() - interval '94 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'riya.gupta', 'password', now() - interval '6 day', now() - interval '14 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 96: Sanjay Majumdar (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('sanjay.majumdar', 'sanjay.majumdar@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer96$hash', 'Sanjay Majumdar', 'active', now() - interval '5 day', now() - interval '95 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'sanjay.majumdar', 'password', now() - interval '5 day', now() - interval '15 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 97: Simran Mukherjee (free plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('simran.mukherjee', 'simran.mukherjee@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer97$hash', 'Simran Mukherjee', 'active', now() - interval '4 day', now() - interval '96 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'simran.mukherjee', 'password', now() - interval '4 day', now() - interval '16 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'free', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 98: Sonia Reddy (plus plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('sonia.reddy', 'sonia.reddy@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer98$hash', 'Sonia Reddy', 'active', now() - interval '3 day', now() - interval '97 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'sonia.reddy', 'password', now() - interval '3 day', now() - interval '17 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'plus', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 99: Theo Sen (pro plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('theo.sen', 'theo.sen@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer99$hash', 'Theo Sen', 'active', now() - interval '2 day', now() - interval '98 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'theo.sen', 'password', now() - interval '2 day', now() - interval '18 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'pro', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

-- User 100: Veda Smith (ultra plan)
DO $$
DECLARE
    v_user_id uuid;
BEGIN
    INSERT INTO consumer.user_account (username, email_normalized, password_hash, display_name, account_status, created_at, updated_at)
    VALUES ('veda.smith', 'veda.smith@individual.io', '$argon2id$v=19$m=65536,t=3,p=4$dummyhashconsumer100$hash', 'Veda Smith', 'active', now() - interval '1 day', now() - interval '99 hour')
    RETURNING user_id INTO v_user_id;

    INSERT INTO consumer.user_identity (user_id, provider, provider_subject, credential_type, created_at, last_authenticated_at)
    VALUES (v_user_id, 'local', 'veda.smith', 'password', now() - interval '1 day', now() - interval '19 hour');

    INSERT INTO consumer.subscription (user_id, plan_code, status, entitlement_version, period_start, period_end, created_at, updated_at)
    VALUES (v_user_id, 'ultra', 'active', 1, now() - interval '15 day', now() + interval '15 day', now() - interval '15 day', now());
END $$;

COMMIT;
