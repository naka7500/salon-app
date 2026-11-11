-- 0024：カルテの手書きページに「画像レイヤー」（線の下に置く写真・画像。動かす・大きさを変える・消す）。
-- ※0010_karte_handwriting.sql の後に流すこと（karte_pages が無いと最初で止まります。DBは何も変わりません）。
-- 何度流しても安全（if not exists / drop ... if exists）。0010 以前の内容はここでは触らない（足すだけ）。
-- 0024 が未適用でもアプリは落ちない（手書き画面に「画像」ボタンが出ないだけ。今までのページはそのまま）。
--
-- やること
--  1) karte_pages.images（jsonb）：ページに置いた画像の一覧
--       [{ "id": "…", "path": "<会社ID>/karte/<カルテID>/<ページID>-img-<画像ID>-<時刻>.jpg", "x": 100, "y": 80, "w": 600, "h": 400 }, …]
--       座標・大きさはページ座標（1414×1000）。画像そのものは 0010 で作った非公開バケット karte の同じ場所に置く
--       （読み書きの権限は 0010／0021 の karte_file_ok と同じ：その会社のスタッフ、書くのは viewer 以外）
--  2) 形のチェック：配列であること・1ページ10枚まで
--  3) 中身のチェック（監査 2026-11-11 L1）：各要素は {id, path, x, y, w, h}。path は「そのカルテの会社ID/karte/…」だけ
--     （data: や https:// などの URL、ほかの会社のパス、巨大なデータは入れられない）

do $$ begin
  if to_regclass('public.karte_pages') is null then
    raise exception '0010 がまだ流れていません。先に 0010_karte_handwriting.sql を流してから、この 0024 を流してください';
  end if;
end $$;

alter table karte_pages add column if not exists images jsonb not null default '[]'::jsonb;

alter table karte_pages drop constraint if exists karte_pages_images_check;
alter table karte_pages add constraint karte_pages_images_check
  check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 10);

-- 中身のチェック（直接 API を呼んで、外部の URL や巨大なデータを入れられないように）
create or replace function guard_karte_page_images() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare cid uuid; el jsonb; k text;
begin
  if new.images is null or jsonb_typeof(new.images) <> 'array' or jsonb_array_length(new.images) = 0 then return new; end if;
  if tg_op = 'UPDATE' and new.images is not distinct from old.images and new.karte_entry_id is not distinct from old.karte_entry_id then return new; end if;
  if length(new.images::text) > 8000 then
    raise exception 'karte_images_invalid' using hint = '0024：置いた画像の情報が大きすぎます';
  end if;
  select s.company_id into cid from karte_entries e join stores s on s.id = e.store_id where e.id = new.karte_entry_id;
  for el in select * from jsonb_array_elements(new.images) loop
    if jsonb_typeof(el) <> 'object' or jsonb_typeof(el->'id') <> 'string' or jsonb_typeof(el->'path') <> 'string' then
      raise exception 'karte_images_invalid' using hint = '0024：置いた画像は {id, path, x, y, w, h} の形で入れます';
    end if;
    foreach k in array array['x', 'y', 'w', 'h'] loop
      if jsonb_typeof(el->k) is distinct from 'number' then
        raise exception 'karte_images_invalid' using hint = '0024：置いた画像の位置・大きさ（x, y, w, h）は数で入れます';
      end if;
    end loop;
    if length(el->>'id') > 80 or length(el->>'path') > 400 or (el->>'path') ~* '^[a-z][a-z0-9+.-]*:' or (el->>'path') like '%..%'
       or cid is null or (el->>'path') not like cid::text || '/karte/%' then
      raise exception 'karte_images_invalid' using hint = '0024：置いた画像の場所は、その会社のカルテ用の保存先（<会社ID>/karte/…）だけです';
    end if;
  end loop;
  return new;
end $$;
revoke all on function guard_karte_page_images() from public, anon, authenticated;
drop trigger if exists t_karte_pages_images on karte_pages;
create trigger t_karte_pages_images before insert or update of images, karte_entry_id on karte_pages
  for each row execute function guard_karte_page_images();

comment on column karte_pages.images is '0024：ページに置いた画像（線の下）。[{id,path,x,y,w,h}] ページ座標 1414×1000。path は Storage（karte バケット）のパス';

-- API（PostgREST）に新しい列をすぐ見せる
notify pgrst, 'reload schema';

-- 確認用（Run の結果に出る）
select '0024 OK：カルテの手書きページに画像レイヤー（karte_pages.images）を足しました' as result,
       (select count(*) from karte_pages) as pages,
       (select count(*) from karte_pages where jsonb_array_length(images) > 0) as pages_with_images;
