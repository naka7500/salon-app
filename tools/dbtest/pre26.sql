-- 0026 を流す直前の土台（tools/dbtest/run.sh から）。「ラシエル箱崎」と同じIDの店舗（すでにネット予約を公開中）と、ふつうの店舗を1つずつ。
-- 0026 が「初めて流したときだけ箱崎を LINEの中だけにする／ほかの店舗は変えない」を確かめるため。検証専用（本番には流さない）
set session_replication_role = replica;
insert into companies (id, name) values ('cccccccc-0000-0000-0000-000000000001', 'C社（予約テスト）');
insert into stores (id, company_id, name, business_type, slug, web_booking_enabled, phone) values
 ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', '箱崎テスト', 'eyelash', 'hako-test', true, '092-000-0000'),
 ('cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-000000000001', '両方テスト', 'eyelash', 'both-test', true, null);
set session_replication_role = origin;
