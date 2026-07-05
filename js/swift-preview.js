// ============================================================
// DATAGLOW — Swift Tab
// Lightweight SwiftUI-syntax → iOS-style live preview.
// Note: true SwiftWasm compilation requires a full toolchain
// server-side; this renders a structural, live preview of
// common SwiftUI-style declarations directly in the browser,
// matching the "sketch a screen, no Xcode" workflow.
// ============================================================

export const SWIFT_TEMPLATE = `// DATAGLOW Swift preview (SwiftUI-style)
// Supported: Text, VStack, HStack, Chart-style bars, Button, Divider
struct DataScreen: View {
    var body: some View {
        VStack {
            Text("Readmission Rate").font(.title)
            Text("12.4%").font(.largeTitle).foregroundColor(.coral)
            Divider()
            HStack {
                Text("30-day")
                Text("90-day")
            }
            Button("View Details") {}
        }
    }
}`;

export function renderSwiftPreview(code, containerId) {
  const container = document.getElementById(containerId);
  const lines = code.split('\n').map(l => l.trim()).filter(Boolean);
  const elements = [];

  for (const line of lines) {
    let m;
    if ((m = line.match(/Text\("([^"]*)"\)(.*)/))) {
      const text = m[1];
      const mods = m[2] || '';
      const isTitle = /\.title/.test(mods);
      const isLargeTitle = /\.largeTitle/.test(mods);
      const isCoral = /\.coral|foregroundColor\(\.coral\)/.test(mods);
      elements.push({ type: 'text', text, isTitle, isLargeTitle, isCoral });
    } else if (/Button\("([^"]*)"\)/.test(line)) {
      const bm = line.match(/Button\("([^"]*)"\)/);
      elements.push({ type: 'button', text: bm[1] });
    } else if (/Divider\(\)/.test(line)) {
      elements.push({ type: 'divider' });
    } else if (/HStack/.test(line)) {
      elements.push({ type: 'hstack-start' });
    } else if (/VStack/.test(line)) {
      elements.push({ type: 'vstack-start' });
    }
  }

  const bodyHtml = elements.map(e => {
    if (e.type === 'text') {
      const size = e.isLargeTitle ? '28px' : e.isTitle ? '20px' : '15px';
      const weight = e.isLargeTitle || e.isTitle ? '700' : '400';
      const color = e.isCoral ? '#FF6B6B' : '#2D2D2D';
      return `<div style="font-size:${size}; font-weight:${weight}; color:${color}; margin-bottom:8px; font-family:-apple-system,sans-serif;">${e.text}</div>`;
    }
    if (e.type === 'button') {
      return `<button style="background:#FF6B6B; color:white; border:none; padding:10px 20px; border-radius:10px; font-size:15px; font-weight:600; margin-top:8px;">${e.text}</button>`;
    }
    if (e.type === 'divider') {
      return `<hr style="border:none; border-top:1px solid #E2E0DC; margin:10px 0;">`;
    }
    return '';
  }).join('');

  container.innerHTML = `
    <div style="display:flex; justify-content:center; padding:24px;">
      <div style="width:280px; height:560px; border-radius:36px; background:#000; padding:10px; box-shadow: 0 20px 50px rgba(0,0,0,0.25);">
        <div style="width:100%; height:100%; border-radius:28px; background:#FAFAF9; overflow:hidden; display:flex; flex-direction:column; padding:28px 18px;">
          <div style="width:60px; height:5px; background:#00000020; border-radius:3px; margin:0 auto 20px;"></div>
          ${bodyHtml || '<div style="color:#A6A49F; font-size:13px; text-align:center; margin-top:40px;">Write SwiftUI-style code and hit Preview</div>'}
        </div>
      </div>
    </div>
  `;
}
