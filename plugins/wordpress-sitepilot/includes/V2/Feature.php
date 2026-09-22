<?php
/**
 * SitePilot v2 feature gate.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

/**
 * Keeps the v2 runtime unavailable until the target-site gate is proven.
 */
final class Feature {

	public const BRIDGE_VERSION = '2.0.0-alpha.1';

	public static function enabled(): bool {
		return defined( 'SITEPILOT_V2_ENABLED' ) && true === SITEPILOT_V2_ENABLED;
	}

	public static function disabled_error(): \WP_Error {
		return new \WP_Error(
			'sitepilot_v2_disabled',
			__( 'SitePilot v2 is disabled until its target-site feasibility gate passes.', 'sitepilot' ),
			array( 'status' => 503 )
		);
	}
}
