<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Commit_Service;

final class V2StatusChangeTest extends TestCase {

	protected function tearDown(): void {
		$GLOBALS['sitepilot_test_denied_caps'] = array();
	}

	private function call( string $method, mixed ...$args ): mixed {
		$reflection = new ReflectionMethod( Commit_Service::class, $method );
		return $reflection->invoke( null, ...$args );
	}

	public function test_only_drafts_and_pending_posts_publish_and_only_published_posts_unpublish(): void {
		$this->assertNull( $this->call( 'check_status_transition', 'draft', 'publish' ) );
		$this->assertNull( $this->call( 'check_status_transition', 'pending', 'publish' ) );
		$this->assertNull( $this->call( 'check_status_transition', 'publish', 'draft' ) );
		foreach ( array( array( 'publish', 'publish' ), array( 'private', 'publish' ), array( 'future', 'publish' ), array( 'draft', 'draft' ), array( 'trash', 'draft' ) ) as $case ) {
			$this->assertInstanceOf( WP_Error::class, $this->call( 'check_status_transition', ...$case ), implode( ' → ', $case ) );
		}
	}

	public function test_a_status_change_needs_the_publish_capability_not_only_edit(): void {
		$this->assertTrue( $this->call( 'can_write', 'set_status', 'post', 12 ) );
		$GLOBALS['sitepilot_test_denied_caps'] = array( 'publish_posts' );
		$this->assertFalse( $this->call( 'can_write', 'set_status', 'post', 12 ) );
		// Content edits of the same post are still allowed.
		$this->assertTrue( $this->call( 'can_write', 'apply_operations', 'post', 12 ) );
	}

	public function test_only_publish_and_draft_are_accepted_targets(): void {
		$this->assertSame( 'publish', $this->call( 'requested_status', array( 'intent' => array( 'status' => array( 'to' => 'publish' ) ) ) ) );
		$this->assertSame( 'draft', $this->call( 'requested_status', array( 'intent' => array( 'status' => array( 'to' => 'draft' ) ) ) ) );
		$this->assertNull( $this->call( 'requested_status', array( 'intent' => array( 'status' => array( 'to' => 'future' ) ) ) ) );
		$this->assertNull( $this->call( 'requested_status', array( 'intent' => array() ) ) );
	}
}
