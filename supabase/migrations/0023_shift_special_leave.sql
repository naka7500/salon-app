-- 0023：シフトの種類に「夏季冬季休暇」（kind = 'seasonal'）を追加（スタッフの要望 2026-11-09）
-- 決まったこと：
--  1) 休暇の一種（出勤 0 日）。休／有給／店休 とは別に数える（集計・CSV で「夏季冬季休暇日数」の列が分かれる）
--  2) shift_patterns.kind と shifts.kind の check 制約に 'seasonal' を足す
--  3) まだ無い店舗に、パターン「夏季冬季休暇」（色 #99f6e4・並び 7＝店休の次）を 1 つ入れる
--  4) 新しい店舗の標準パターン（ensure_default_shift_patterns）にも入れる（7件）
-- ※必ず 0022 の後に流すこと（無いと最初で止まります。DBは何も変わりません）。
-- ※何度流しても同じ（drop ... if exists / not exists / create or replace）。

begin;

do $$ begin
  if to_regprocedure('public.service_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[], text, text)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'companies' and column_name = 'legal_name') then
    raise exception '0022 が流れていません。先に 0022_line_identity.sql を流してから、もう一度 0023 を流してください（DBは何も変わっていません）';
  end if;
  if to_regclass('public.shift_patterns') is null then
    raise exception '0005 が流れていません（shift_patterns が無い）。先に 0005_shifts.sql を流してください（DBは何も変わっていません）';
  end if;
end $$;

-- 1) 種類の制約に 'seasonal' を足す（0005 で付いた制約名はどちらも shifts_kind_check / shift_patterns_kind_check）
alter table shift_patterns drop constraint if exists shift_patterns_kind_check;
alter table shift_patterns add constraint shift_patterns_kind_check check (kind in ('work','off','paid','closed','seasonal'));
alter table shifts drop constraint if exists shifts_kind_check;
alter table shifts add constraint shifts_kind_check check (kind in ('work','off','paid','closed','seasonal'));
comment on column shifts.kind is 'work=出勤／off=休み／paid=有給／closed=店休／seasonal=夏季冬季休暇（0023。休暇だが有給とは別に数える）';

-- 2) まだ無い店舗にパターンを入れる（消した＝active=false の店舗には入れ直さない）
insert into shift_patterns (store_id, name, kind, start_time, end_time, color, sort_order)
select s.id, '夏季冬季休暇', 'seasonal', null, null, '#99f6e4', 7
  from stores s
 where not exists (select 1 from shift_patterns p where p.store_id = s.id and p.kind = 'seasonal');

-- 3) 新しい店舗の標準パターン（0005 の関数を 7 件に）
create or replace function ensure_default_shift_patterns(p_store uuid) returns int language plpgsql as $$
declare o time; c time; n int;
begin
  select count(*) into n from shift_patterns where store_id = p_store;
  if n > 0 then return 0; end if;
  select open_time, close_time into o, c from stores where id = p_store;
  if o is null then return 0; end if;
  insert into shift_patterns (store_id, name, kind, start_time, end_time, color, sort_order) values
    (p_store, '通し', 'work',   o, c, '#2f6b4f', 1),
    (p_store, '早番', 'work',   o, o + interval '6 hours', '#d9a441', 2),
    (p_store, '遅番', 'work',   c - interval '6 hours', c, '#7a9cd9', 3),
    (p_store, '休',   'off',    null, null, '#d6d3d1', 4),
    (p_store, '有給', 'paid',   null, null, '#f9a8d4', 5),
    (p_store, '店休', 'closed', null, null, '#78716c', 6),
    (p_store, '夏季冬季休暇', 'seasonal', null, null, '#99f6e4', 7);
  return 7;
end $$;
revoke all on function ensure_default_shift_patterns(uuid) from public, anon;
grant execute on function ensure_default_shift_patterns(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;

-- 4) 結果
select '0023 OK：シフトの種類に「夏季冬季休暇」（seasonal）を追加。パターンがある店舗 '
       || (select count(distinct store_id) from shift_patterns where kind = 'seasonal') || '／' || (select count(*) from stores) || ' 店舗' as result;
