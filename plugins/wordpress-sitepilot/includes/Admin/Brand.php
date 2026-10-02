<?php
/**
 * The SitePilot mark.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Admin;

/**
 * The mark as inline SVG, for page headings. The source is
 * assets/brand/sitepilot-mark.svg in the SitePilot repository.
 */
final class Brand {

	/**
	 * A heading with the mark before its text. The text is escaped here.
	 */
	public static function heading( string $text ): string {
		return '<h1 style="display:flex;align-items:center;gap:10px">'
			. '<svg viewBox="0 0 64 64" width="32" height="32" aria-hidden="true" style="flex:none">'
			. '<rect width="64" height="64" rx="14" fill="#0e6a61"/>'
			. '<path d="M36 21h-8a7 7 0 0 0 0 14h6a7 7 0 0 1 0 14H19" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>'
			. '<path d="M36.5 13.5 46.5 21l-10 7.5Z" fill="#f2862e" stroke="#f2862e" stroke-width="2.4" stroke-linejoin="round"/>'
			. '</svg>' . esc_html( $text ) . '</h1>';
	}
}
