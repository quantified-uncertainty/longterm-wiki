/**
 * Tests for stripHtmlForLlm script-block removal.
 *
 * The closing-tag patterns tolerate trailing whitespace/junk
 * (`</script\t\n junk>`) so a crafted page cannot slip a script block past the
 * filter by mangling the closing tag.
 */

import { describe, it, expect } from 'vitest';
import { stripHtmlForLlm } from './html-utils.ts';

describe('stripHtmlForLlm', () => {
  it('removes a normal <script>...</script> block entirely', () => {
    const html = '<p>before</p><script>var x = 1; alert(2);</script><p>after</p>';
    const out = stripHtmlForLlm(html);

    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('var x = 1');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('removes a script block whose closing tag has whitespace/junk', () => {
    // Closing tag is `</script\t\n junk>` — must still be stripped.
    const html =
      '<p>before</p><script>steal();document.cookie;</script\t\n junk><p>after</p>';
    const out = stripHtmlForLlm(html);

    // The entire script payload must be gone.
    expect(out).not.toContain('<script');
    expect(out).not.toContain('steal');
    expect(out).not.toContain('document.cookie');
    // No residual closing-tag junk should leak through as text.
    expect(out).not.toContain('junk');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });
});
