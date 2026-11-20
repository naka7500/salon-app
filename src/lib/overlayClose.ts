// 背景（overlay）をクリックしたら閉じる、を安全にする部品。
// フォームの中で文字をドラッグ選択して背景の上で指（マウス）を離すと、ブラウザは click を背景に発火させる
// （mousedown と mouseup の共通の親＝背景が click の target になる）ため、onClick={close} だけだと閉じてしまう。
// mousedown も click も「背景そのもの」で起きたときだけ閉じる（増美さん 2026-11-20：ユーザー追加でパスワードをコピーしようとしたら閉じた）。
import { useCallback, useRef, type MouseEvent } from "react";

export function useOverlayClose(onClose: () => void) {
  const armed = useRef(false);
  const onMouseDown = useCallback((e: MouseEvent) => { armed.current = e.target === e.currentTarget; }, []);
  const onClick = useCallback((e: MouseEvent) => {
    const hit = armed.current && e.target === e.currentTarget;
    armed.current = false;
    if (hit) onClose();
  }, [onClose]);
  return { onMouseDown, onClick };
}
