/**
 * Component Props Validation Rule
 *
 * Validates that certain components are used with required props, not children.
 * For example, KeyPeople requires `people={[...]}` prop, not `<KeyPeople>content</KeyPeople>`.
 */

import { Severity, Issue } from '../validation-engine.mjs';

// Components that require specific props and cannot have children
const PROP_REQUIRED_COMPONENTS = [
  {
    name: 'KeyPeople',
    requiredProp: 'people',
    example: '<KeyPeople people={[{ name: "...", role: "..." }]} />',
  },
  {
    name: 'KeyQuestions',
    requiredProp: 'questions',
    example: '<KeyQuestions questions={["Question 1?", "Question 2?"]} />',
  },
];

export const componentPropsRule = {
  id: 'component-props',
  name: 'Component Props',
  description: 'Validate that components requiring props are not used with children',
  severity: Severity.ERROR,

  check(contentFile, engine) {
    const issues = [];
    const content = contentFile.body || '';
    if (!content) return issues;

    for (const component of PROP_REQUIRED_COMPONENTS) {
      // Pattern: <ComponentName> followed by content (not self-closing, not with required prop)
      // This catches: <KeyPeople>\n- content\n</KeyPeople>
      const openTagPattern = new RegExp(`<${component.name}(?![^>]*${component.requiredProp}=)(?![^>]*/>)[^>]*>`, 'g');

      let match;
      while ((match = openTagPattern.exec(content)) !== null) {
        // Find line number
        const beforeMatch = content.substring(0, match.index);
        const lineNumber = beforeMatch.split('\n').length;

        // Check if this is followed by a closing tag (meaning it has children)
        const afterMatch = content.substring(match.index);
        const closingTagPattern = new RegExp(`</${component.name}>`);
        if (closingTagPattern.test(afterMatch)) {
          issues.push(new Issue({
            rule: 'component-props',
            file: contentFile.path,
            line: lineNumber,
            message: `${component.name} requires '${component.requiredProp}' prop, not children. Use: ${component.example}`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    return issues;
  },
};
