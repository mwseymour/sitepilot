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

	public function test_installed_media_is_readable_like_other_uploads(): void {
		$folder = sys_get_temp_dir() . '/sitepilot-media-' . bin2hex( random_bytes( 4 ) );
		mkdir( $folder, 0755 );
		// tempnam() makes owner-only files, which a separate web server user can't serve.
		$file = (string) tempnam( $folder, '.sitepilot-v2-' );
		$this->assertSame( 0600, fileperms( $file ) & 0777 );

		$method = new ReflectionMethod( Media_Service::class, 'make_readable_like_uploads' );
		$method->setAccessible( true );
		$method->invoke( null, $file );
		clearstatcache();

		$this->assertSame( 0644, fileperms( $file ) & 0777 );
		unlink( $file );
		rmdir( $folder );
	}
}
