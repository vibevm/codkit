# PR checklist codkit

## Контекст

- patchSet branch/commit: `<ref>`
- Base ref: `<ref>`
- Pin: `<tag>@<full-sha>`
- Изменение: `<one sentence>`
- Layer leaf из [03](../03-interventions.md): `<layer>`
- Owner/reviewer: `<owner>` / `<reviewer>`

## Проверяемые пункты автора

- [ ] `git status --short` до проверки показывает только ожидаемые пути: `<paths>`.
- [ ] `codkit status` → exit `<0|1>`; все названные paths объяснены.
- [ ] `codkit save` → exit `0` либо `not applicable: <non-own/non-patch authoring>`.
- [ ] `codkit verify` → exit `0`.
- [ ] `codkit inventory --diff <base-ref> --md` → exit `0`; inventory delta: `<summary>`.
- [ ] `codkit ci --profile verify --pin-guard-base <base-ref> --effective-diff <base-ref>` → exit `0`.
- [ ] Contract/guard test `<id|not required by layer>` → command `<command>`, exit `<code>`.
- [ ] Upstream-file diff находится только в marker block либо выбран более высокий layer.
- [ ] `git diff --check <base-ref>...HEAD` → exit `0`.

## Проверяемые пункты ревьюера

- [ ] Effective diff, не только `.ckpatch`, прочитан: `<artifact link>`.
- [ ] Inventory diff прочитан; id/owner/subsystem/cause/pin/contractTests согласованы.
- [ ] Более высокий layer из дерева решений неприменим: `<observed reason>`.
- [ ] Для rule просмотрены все matches; для overlay/resource/hide есть green guard-test.
- [ ] Pin guard green; при S12 выполнена no-ff merge/rebase/receipt процедура.
- [ ] Нет текстовой нормы без command/hook/CI; gap связан с mechanism issue `<link|none>`.

## Merge

- [ ] Обычный feature PR соответствует политике команды: `<merge mode>`.
- [ ] Cycle PR использует merge commit/no-ff, squash/rebase merge выключены.
- [ ] Cycle terminal: `cycle status` completed, `cycle/state.json` absent, CSV row present.
