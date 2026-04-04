--
-- PostgreSQL database dump
--

\restrict aGTwCMvNypE7KklgRVwurAsK7JrOwF78EOlVAHek1A8v7SXPz7ifweLN2wKHdj7

-- Dumped from database version 16.13 (Homebrew)
-- Dumped by pg_dump version 16.13 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: lema; Type: SCHEMA; Schema: -; Owner: emmamendez
--

CREATE SCHEMA lema;


ALTER SCHEMA lema OWNER TO emmamendez;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: insight_catalog; Type: TABLE; Schema: lema; Owner: emmamendez
--

CREATE TABLE lema.insight_catalog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    domain text NOT NULL,
    priority_rank integer,
    source text,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE lema.insight_catalog OWNER TO emmamendez;

--
-- Name: protocols; Type: TABLE; Schema: lema; Owner: emmamendez
--

CREATE TABLE lema.protocols (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version text NOT NULL,
    description text,
    active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE lema.protocols OWNER TO emmamendez;

--
-- Name: questions; Type: TABLE; Schema: lema; Owner: emmamendez
--

CREATE TABLE lema.questions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    protocol_version text,
    day_number integer,
    question_key text,
    question_text text,
    domain text,
    created_at timestamp without time zone DEFAULT now(),
    response_type text,
    active boolean DEFAULT true,
    protocol_id uuid
);


ALTER TABLE lema.questions OWNER TO emmamendez;

--
-- Name: reflections; Type: TABLE; Schema: lema; Owner: emmamendez
--

CREATE TABLE lema.reflections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    reflection_type text,
    period_days integer,
    summary text,
    insight_data jsonb,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE lema.reflections OWNER TO emmamendez;

--
-- Name: response_options; Type: TABLE; Schema: lema; Owner: emmamendez
--

CREATE TABLE lema.response_options (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    question_key text NOT NULL,
    option_value text NOT NULL,
    option_label text NOT NULL,
    sort_order integer DEFAULT 0,
    active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE lema.response_options OWNER TO emmamendez;

--
-- Name: signals; Type: TABLE; Schema: lema; Owner: emmamendez
--

CREATE TABLE lema.signals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    day_number integer,
    question_key text,
    response_value text,
    domain text DEFAULT 'bloating'::text,
    created_at timestamp without time zone DEFAULT now(),
    time_of_day text,
    response_metadata jsonb
);


ALTER TABLE lema.signals OWNER TO emmamendez;

--
-- Name: streaks; Type: TABLE; Schema: lema; Owner: emmamendez
--

CREATE TABLE lema.streaks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    current_streak integer DEFAULT 0,
    longest_streak integer DEFAULT 0,
    last_active date,
    start_date date
);


ALTER TABLE lema.streaks OWNER TO emmamendez;

--
-- Name: user_profiles; Type: TABLE; Schema: lema; Owner: emmamendez
--

CREATE TABLE lema.user_profiles (
    id uuid NOT NULL,
    user_type text NOT NULL,
    region text,
    country text,
    city text,
    cohort_version text,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE lema.user_profiles OWNER TO emmamendez;

--
-- Name: waist_measurements; Type: TABLE; Schema: public; Owner: emmamendez
--

CREATE TABLE public.waist_measurements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    waist_value numeric(5,2),
    source text DEFAULT 'wearable'::text,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.waist_measurements OWNER TO emmamendez;

--
-- Data for Name: insight_catalog; Type: TABLE DATA; Schema: lema; Owner: emmamendez
--

COPY lema.insight_catalog (id, domain, priority_rank, source, created_at) FROM stdin;
2970d636-e6ed-409f-81cb-9518f6c4ebbd	bloating	1	community_vote	2026-04-02 23:11:27.443763
9db89bf7-5f6c-4e17-9a5f-2b31a4d5b2bf	cycle	2	community_vote	2026-04-02 23:11:27.443763
45e6d59b-830b-4728-8dee-6b96e4da17e8	sleep	3	community_vote	2026-04-02 23:11:27.443763
5ff47faa-b4f7-45e2-b262-fec72f17d47d	hydration	4	community_vote	2026-04-02 23:11:27.443763
862cd3f0-62e8-4c88-bdd8-b4541cb46b4a	movement	5	community_vote	2026-04-02 23:11:27.443763
96b23ba9-3afa-4ac5-ba63-f52b4cd6eb17	heart_rate	6	community_vote	2026-04-02 23:11:27.443763
\.


--
-- Data for Name: protocols; Type: TABLE DATA; Schema: lema; Owner: emmamendez
--

COPY lema.protocols (id, version, description, active, created_at) FROM stdin;
8c58a031-49ac-4258-8466-bc74545d0d3b	EARLY_V1	Initial early adopter daily behavioural protocol	t	2026-04-03 00:36:21.921403
\.


--
-- Data for Name: questions; Type: TABLE DATA; Schema: lema; Owner: emmamendez
--

COPY lema.questions (id, protocol_version, day_number, question_key, question_text, domain, created_at, response_type, active, protocol_id) FROM stdin;
35fc2130-f94c-4c31-9302-190819949b82	EARLY_V1	1	day_reflection	Talk to me about your day. How has your day been so far?	emotion	2026-04-03 00:36:48.85273	text_long	t	\N
3cc2766b-f470-442a-b02f-126ae763b11f	EARLY_V1	1	emotional_state	How did that make you feel?	emotion	2026-04-03 00:36:48.85273	selection	t	\N
9d657263-5a36-456b-89fd-65535cd7fc6c	EARLY_V1	1	eating_state	How did you eat today?	nutrition	2026-04-03 00:36:48.85273	selection	t	\N
9de7bb85-2ed4-417c-90c1-a279de9ef05e	EARLY_V1	1	tummy_state	How does your tummy feel now?	bloating	2026-04-03 00:36:48.85273	selection	t	\N
33786ebd-dbbc-4171-bdb2-9c32547d10fd	EARLY_V1	1	cycle_status	Are you on your menstrual cycle?	cycle	2026-04-03 00:36:48.85273	selection	t	\N
\.


--
-- Data for Name: reflections; Type: TABLE DATA; Schema: lema; Owner: emmamendez
--

COPY lema.reflections (id, user_id, reflection_type, period_days, summary, insight_data, created_at) FROM stdin;
\.


--
-- Data for Name: response_options; Type: TABLE DATA; Schema: lema; Owner: emmamendez
--

COPY lema.response_options (id, question_key, option_value, option_label, sort_order, active, created_at) FROM stdin;
2c050a49-1026-44fe-a20c-8f8b8a942217	emotional_state	calm	Calm	1	t	2026-04-03 14:27:09.724071
d386529c-cd9f-4699-a9a7-55f05f04ac73	eating_state	fasting	Fasting	1	t	2026-04-03 14:27:09.724071
fe08498a-91dc-4a17-9b04-2ce0e62bf0ac	eating_state	hungry	Hungry	2	t	2026-04-03 14:27:09.724071
81acbea7-ff6d-4f69-bf03-1731e36cafff	eating_state	full	Full	3	t	2026-04-03 14:27:09.724071
e7e4423d-c6eb-447f-8238-fc0798c767a7	eating_state	overly_full	Overly full	4	t	2026-04-03 14:27:09.724071
0fa10366-70bc-475a-a7a5-917263894da5	eating_state	content	Content	5	t	2026-04-03 14:27:09.724071
3d71927c-5a8a-46c1-ba81-6b262ed60766	tummy_state	bloated	Bloated	1	t	2026-04-03 14:27:09.724071
3f137471-75fd-4d15-a4be-bd84967f7333	tummy_state	inflamed	Inflamed	4	t	2026-04-03 14:27:09.724071
544df36b-ba0a-429d-a5bc-6c985ae1490c	cycle_status	yes	Yes	1	t	2026-04-03 14:27:09.724071
8a32192d-863e-4299-ba59-54015b24eb34	cycle_status	no	No	2	t	2026-04-03 14:27:09.724071
8c32a171-173f-449c-9d67-21319f5ddfad	cycle_status	starting_soon	Starting soon	3	t	2026-04-03 14:27:09.724071
c0183991-119a-4258-9b3e-a263682f8432	cycle_status	finishing_soon	Finishing soon	4	t	2026-04-03 14:27:09.724071
3cd00d37-a24e-45c6-b6e0-de8d736c2fcc	emotional_state	productive	Productive	2	t	2026-04-03 15:30:27.516786
10074f59-6c75-43a1-9bee-fac075624bf7	emotional_state	anxious	Anxious	3	t	2026-04-03 15:30:27.516786
42f40d78-bfea-4f90-ae41-f6f2cfc9655b	emotional_state	overwhelmed	Overwhelmed	4	t	2026-04-03 15:30:27.516786
0510f17f-6e7e-487e-b3ad-cf378b3b70e9	tummy_state	flat	Flat	2	t	2026-04-03 15:30:27.516786
2d6843c3-6034-4db4-8947-5adf5fb42a9e	tummy_state	round	Round	3	t	2026-04-03 15:30:27.516786
bf5c4b34-9473-4386-9a6a-8cba9ce81246	tummy_state	empty	Empty	5	t	2026-04-03 15:30:27.516786
\.


--
-- Data for Name: signals; Type: TABLE DATA; Schema: lema; Owner: emmamendez
--

COPY lema.signals (id, user_id, day_number, question_key, response_value, domain, created_at, time_of_day, response_metadata) FROM stdin;
474f658d-1fdf-4733-a59a-c5bc90a13fcb	11111111-1111-1111-1111-111111111111	1	cycle_status	no	cycle	2026-04-03 20:57:24.786016	\N	\N
\.


--
-- Data for Name: streaks; Type: TABLE DATA; Schema: lema; Owner: emmamendez
--

COPY lema.streaks (id, user_id, current_streak, longest_streak, last_active, start_date) FROM stdin;
b91ff25b-6c73-4566-8270-00f2d4e17611	11111111-1111-1111-1111-111111111111	1	1	2026-04-03	2026-04-03
\.


--
-- Data for Name: user_profiles; Type: TABLE DATA; Schema: lema; Owner: emmamendez
--

COPY lema.user_profiles (id, user_type, region, country, city, cohort_version, created_at) FROM stdin;
\.


--
-- Data for Name: waist_measurements; Type: TABLE DATA; Schema: public; Owner: emmamendez
--

COPY public.waist_measurements (id, user_id, waist_value, source, created_at) FROM stdin;
99001f2f-bfff-48de-addd-45e3ecacbd0b	11111111-1111-1111-1111-111111111111	32.70	wearable	2026-03-31 20:49:45.503808
3fed0f6a-9dae-4ff4-bc50-7f1f8fd9ca43	11111111-1111-1111-1111-111111111111	32.70	wearable	2026-03-31 22:14:18.840477
\.


--
-- Name: insight_catalog insight_catalog_pkey; Type: CONSTRAINT; Schema: lema; Owner: emmamendez
--

ALTER TABLE ONLY lema.insight_catalog
    ADD CONSTRAINT insight_catalog_pkey PRIMARY KEY (id);


--
-- Name: protocols protocols_pkey; Type: CONSTRAINT; Schema: lema; Owner: emmamendez
--

ALTER TABLE ONLY lema.protocols
    ADD CONSTRAINT protocols_pkey PRIMARY KEY (id);


--
-- Name: questions questions_pkey; Type: CONSTRAINT; Schema: lema; Owner: emmamendez
--

ALTER TABLE ONLY lema.questions
    ADD CONSTRAINT questions_pkey PRIMARY KEY (id);


--
-- Name: reflections reflections_pkey; Type: CONSTRAINT; Schema: lema; Owner: emmamendez
--

ALTER TABLE ONLY lema.reflections
    ADD CONSTRAINT reflections_pkey PRIMARY KEY (id);


--
-- Name: response_options response_options_pkey; Type: CONSTRAINT; Schema: lema; Owner: emmamendez
--

ALTER TABLE ONLY lema.response_options
    ADD CONSTRAINT response_options_pkey PRIMARY KEY (id);


--
-- Name: signals signals_pkey; Type: CONSTRAINT; Schema: lema; Owner: emmamendez
--

ALTER TABLE ONLY lema.signals
    ADD CONSTRAINT signals_pkey PRIMARY KEY (id);


--
-- Name: streaks streaks_pkey; Type: CONSTRAINT; Schema: lema; Owner: emmamendez
--

ALTER TABLE ONLY lema.streaks
    ADD CONSTRAINT streaks_pkey PRIMARY KEY (id);


--
-- Name: signals unique_daily_signal; Type: CONSTRAINT; Schema: lema; Owner: emmamendez
--

ALTER TABLE ONLY lema.signals
    ADD CONSTRAINT unique_daily_signal UNIQUE (user_id, day_number, question_key);


--
-- Name: streaks unique_user_streak; Type: CONSTRAINT; Schema: lema; Owner: emmamendez
--

ALTER TABLE ONLY lema.streaks
    ADD CONSTRAINT unique_user_streak UNIQUE (user_id);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: lema; Owner: emmamendez
--

ALTER TABLE ONLY lema.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (id);


--
-- Name: waist_measurements waist_measurements_pkey; Type: CONSTRAINT; Schema: public; Owner: emmamendez
--

ALTER TABLE ONLY public.waist_measurements
    ADD CONSTRAINT waist_measurements_pkey PRIMARY KEY (id);


--
-- Name: SCHEMA lema; Type: ACL; Schema: -; Owner: emmamendez
--

GRANT USAGE ON SCHEMA lema TO klps_app;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO klps_app;


--
-- Name: TABLE insight_catalog; Type: ACL; Schema: lema; Owner: emmamendez
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE lema.insight_catalog TO klps_app;


--
-- Name: TABLE protocols; Type: ACL; Schema: lema; Owner: emmamendez
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE lema.protocols TO klps_app;


--
-- Name: TABLE questions; Type: ACL; Schema: lema; Owner: emmamendez
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE lema.questions TO klps_app;


--
-- Name: TABLE reflections; Type: ACL; Schema: lema; Owner: emmamendez
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE lema.reflections TO klps_app;


--
-- Name: TABLE response_options; Type: ACL; Schema: lema; Owner: emmamendez
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE lema.response_options TO klps_app;


--
-- Name: TABLE signals; Type: ACL; Schema: lema; Owner: emmamendez
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE lema.signals TO klps_app;


--
-- Name: TABLE streaks; Type: ACL; Schema: lema; Owner: emmamendez
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE lema.streaks TO klps_app;


--
-- Name: TABLE user_profiles; Type: ACL; Schema: lema; Owner: emmamendez
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE lema.user_profiles TO klps_app;


--
-- Name: TABLE waist_measurements; Type: ACL; Schema: public; Owner: emmamendez
--

GRANT SELECT,INSERT ON TABLE public.waist_measurements TO klps_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: lema; Owner: emmamendez
--

ALTER DEFAULT PRIVILEGES FOR ROLE emmamendez IN SCHEMA lema GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO klps_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: emmamendez
--

ALTER DEFAULT PRIVILEGES FOR ROLE emmamendez IN SCHEMA public GRANT SELECT,INSERT ON TABLES TO klps_app;


--
-- PostgreSQL database dump complete
--

\unrestrict aGTwCMvNypE7KklgRVwurAsK7JrOwF78EOlVAHek1A8v7SXPz7ifweLN2wKHdj7

