import { describe, expect, it } from "vitest";
import { cleanupEmailHtml, renderHtmlEmail } from "./body-format.js";

describe("cleanupEmailHtml", () => {
  it("removes style blocks, comments, tracking images, and hidden preheaders", () => {
    const html = `
      <html>
        <head>
          <style>.x { color: red; }</style>
          <script>console.log("nope")</script>
        </head>
        <body>
          <!-- comment -->
          <div style="display:none; max-height:0; overflow:hidden">PREHEADER TEXT</div>
          <img src="https://example.com/pixel.gif" width="1" height="1" />
          <p>Hello world</p>
        </body>
      </html>
    `;

    const cleaned = cleanupEmailHtml(html);

    expect(cleaned).not.toContain("PREHEADER TEXT");
    expect(cleaned).not.toContain("<style>");
    expect(cleaned).not.toContain("<script>");
    expect(cleaned).not.toContain("comment");
    expect(cleaned).not.toContain("pixel.gif");
    expect(cleaned).toContain("Hello world");
  });
});

describe("renderHtmlEmail", () => {
  it("renders links and simple tables readably", () => {
    const html = `
      <html>
        <body>
          <p>Invoice ready. <a href="https://example.com/invoice/123">View invoice</a></p>
          <table>
            <tr><th>Name</th><th>Value</th></tr>
            <tr><td>Plan</td><td>Pro</td></tr>
          </table>
        </body>
      </html>
    `;

    const rendered = renderHtmlEmail(html, 80);

    expect(rendered.text).toContain("Invoice ready.");
    expect(rendered.text).toContain("View invoice [https://example.com/invoice/123]");
    expect(rendered.text).toContain("Name");
    expect(rendered.text).toContain("Value");
    expect(rendered.text).toContain("Plan");
    expect(rendered.text).toContain("Pro");
    expect(rendered.quality).toBe("high");
    expect(rendered.warnings).toEqual([]);
  });

  it("flags CSS-heavy output as low quality", () => {
    const html = `
      <html>
        <body>
          <p>font-family: Arial;</p>
          <p>@font-face test</p>
          <p>mso-line-height-rule: exactly;</p>
          <p>Hello</p>
        </body>
      </html>
    `;

    const rendered = renderHtmlEmail(html, 80);

    expect(rendered.quality).toBe("low");
    expect(rendered.warnings[0]).toContain("press O");
  });
});
