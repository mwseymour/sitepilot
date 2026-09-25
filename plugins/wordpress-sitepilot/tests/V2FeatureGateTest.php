<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Feature;

require_once __DIR__ . '/../includes/V2/Feature.php';

final class V2FeatureGateTest extends TestCase {

	public function test_v2_is_enabled_by_default(): void {
		$this->assertTrue( Feature::enabled() );
	}

	public function test_disabled_v2_has_a_versioned_bridge_identity(): void {
		$this->assertSame( '2.0.0-alpha.1', Feature::BRIDGE_VERSION );
	}
}
