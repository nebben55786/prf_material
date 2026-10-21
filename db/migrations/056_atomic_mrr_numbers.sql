create table mrr_number_counters (
  job_id bigint primary key references jobs(id),
  prefix text not null,
  number_width integer not null check(number_width>0),
  last_number bigint not null check(last_number>0)
);
