# EZ Preview 1.0.0-rc.4 · Complete Changelog

RC3 기반 Playback Priority Hotfix 스냅샷에 버그 수정, 색보정 정밀도 개선, 대량 클립 최적화, **듀얼 덱 컷/디졸브 퀵 시퀀스 + In/Out 트림 + FFmpeg MP4 내보내기**, 그리고 **GitHub Releases 자동 배포**까지 모두 반영한 RC4 완성 소스 패키지입니다.

## 주요 변경 내역

### 1단계 · 버그 수정, Export 정밀도 개선, 버전 정합화
- **변환 중 파일 추가/드롭 즉시 전환 (`index.html`)**: `onFiles()`의 `compatibilityBusy` 차단을 제거해, 변환 중 새 클립을 추가해도 기존 작업을 취소하고 새 클립으로 바로 전환합니다.
- **Scopes 분할 비교 버그 수정 (`index.html`)**: `prepareScopeFrame()`이 `shouldRenderGrade()`를 확인하도록 고쳐, LUT 없이 색상 조정만 켠 분할 비교에서도 스코프가 정확히 분할 샘플링됩니다.
- **16-bit PNG 내보내기 정밀도 개선 (`main.cjs`)**: LUT 단독은 무손실 통과, LUT + 색상 조정 조합은 65³ 고밀도 큐브로 베이크(MAE `0.20 → 0.05 / 255`, 최대 오차 `11.23 → 5.18 / 255`).
- **미사용 IPC 정리 및 RC4 버전 통일**: `deleteTempProxy` 잔재 제거, `package.json`·워크플로우·테스트를 `1.0.0-rc.4`로 정합화.

### 2단계 · 초기 로딩 및 대량 클립 성능 최적화
- **번들 LUT 외부 분리 (`assets/bundled-dji-dlogm.cube`)**: `index.html` 본문의 1 MB 내장 LUT를 분리해 최초 1회 시드 시에만 지연 로드(`ez-native:get-bundled-lut`).
- **대량 클립 가져오기 최적화 (`index.html`)**: `onFiles()` 중복 검사를 `Map` 기반 O(1)로 개선(2,000클립 기준 `41.55ms → 0.78ms`), `renderMediaBin()` 단일 `replaceChildren(...rows)` 배치 교체 및 `MutationObserver` 부하 차단.

### 3단계 · 현장용 컷/디졸브 퀵 시퀀스 & MP4 내보내기
- **듀얼 덱(`video` + `videoB`) + WebGL2 실시간 크로스 디졸브**: 하단 접이식 시퀀스 바(`S` 키)에서 클립 연결·순서 변경·`CUT / Dissolve(0.3s~1.5s)` 원클릭 전환, 실시간 LUT/조정/오디오 크로스페이드 연속 재생.
- **클립별 In / Out 트리밍**: `Set In` / `Set Out` (`Shift+I` / `Shift+O`) 및 초기화 지원.
- **FFmpeg `xfade` + `acrossfade` 시퀀스 MP4 내보내기 (`main.cjs`, `preload.cjs`)**: 트림·디졸브·LUT/조정·오디오/무음 혼합 클립을 한 번에 MP4로 렌더링.

### 4단계 · GitHub Releases 자동 배포
- `.github/workflows/build-release.yml`에 `publish-release` Job 추가: `v1.0.0-rc.4` 태그를 푸시하면 Windows `.exe` + macOS `.dmg` + 체크섬이 GitHub Releases 페이지에 자동 업로드됩니다.

## Codespaces에서 태그 푸시로 자동 배포하는 법
```bash
unzip -o EZ-Preview-1.0.0-rc.4-Complete.zip && cp -a ez_preview_release_rc4/. . && rm -rf ez_preview_release_rc4 EZ-Preview-1.0.0-rc.4-Complete.zip
git add -A && git commit -m "release: EZ Preview 1.0.0-rc.4 with Quick Sequence & auto-release"
git push && git tag v1.0.0-rc.4 && git push origin v1.0.0-rc.4
```
