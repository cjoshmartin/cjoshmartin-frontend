import studio from '@sanity/eslint-config-studio'

export default [
  // functions/ is its own package (own package.json, tsconfig and tests), checked by its own scripts.
  {ignores: ['dist/**', '.sanity/**', 'functions/**']},
  ...studio,
]
