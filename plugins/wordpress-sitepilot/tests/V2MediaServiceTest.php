<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Media_Service;

final class V2MediaServiceTest extends TestCase {

	public function test_binding_id_matches_typescript_nul_delimited_fixture(): void {
		$method = new ReflectionMethod( Media_Service::class, 'binding_id' );
		$method->setAccessible( true );

		$this->assertSame(
			'730b4ba345eefb7e763bba830bcc62b95bbe16381bae9f3cc28ddfd76e10e0de',
			$method->invoke( null, 'execution-1', 'image-1' )
		);
	}

	public function test_staged_mime_policy_does_not_accept_unapproved_aliases(): void {
		$method = new ReflectionMethod( Media_Service::class, 'mime_matches' );
		$method->setAccessible( true );

		$this->assertTrue( $method->invoke( null, 'image/jpeg', 'image/jpeg' ) );
		$this->assertFalse( $method->invoke( null, 'image/png', 'application/octet-stream' ) );
		$this->assertTrue( $method->invoke( null, 'video/mp4', 'video/mp4' ) );
		$this->assertTrue( $method->invoke( null, 'video/webm', 'video/webm' ) );
		$this->assertFalse( $method->invoke( null, 'video/mp4', 'video/quicktime' ) );
		$this->assertFalse( $method->invoke( null, 'video/quicktime', 'video/quicktime' ) );
	}
}
