// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

/**
 * The version of the Codkit runtime library. It must equal the name of the
 * directory the library ships in (`codkit/runtime/v<version>`); `codkit runtime
 * load` refuses a library whose literal and directory disagree.
 */
export const CODKIT_RUNTIME_VERSION = '1.0.0';

/**
 * Upstream tags on which this version of the library was typechecked against
 * the upstream sources and passed its own tests. `codkit runtime load` warns
 * when the product's pin is not in this list.
 */
export const CODKIT_RUNTIME_VERIFIED_UPSTREAM: readonly string[] = ['1.135.0'];
