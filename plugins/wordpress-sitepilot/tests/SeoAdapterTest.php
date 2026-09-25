<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\Seo\Seo_Adapter;

final class SeoAdapterTest extends TestCase {

	protected function setUp(): void {
		$GLOBALS['sitepilot_test_post_meta'] = array();
	}

	public function test_describes_the_active_plugin_and_its_fields(): void {
		$this->assertSame( 'yoast', Seo_Adapter::describe()['plugin'] );
		$this->assertSame( '27.4', Seo_Adapter::describe()['version'] );
		$this->assertContains( 'focusKeyphrase', Seo_Adapter::describe()['fields'] );
		$this->assertSame( '_yoast_wpseo_metadesc', Seo_Adapter::meta_keys()['description'] );
	}

	public function test_reads_neutral_values_with_defaults(): void {
		$GLOBALS['sitepilot_test_post_meta'][7] = array(
			'_yoast_wpseo_title'                => '%%title%% %%sep%% %%sitename%%',
			'_yoast_wpseo_meta-robots-noindex' => '1',
		);
		$values = Seo_Adapter::read( 7 );
		$this->assertSame( '%%title%% %%sep%% %%sitename%%', $values['title'] );
		$this->assertSame( '', $values['description'] );
		$this->assertSame( 'noindex', $values['indexing'] );
		$this->assertSame( 'default', Seo_Adapter::read( 8 )['indexing'] );
	}

	public function test_writes_values_and_clears_empty_ones(): void {
		$GLOBALS['sitepilot_test_post_meta'][7] = array( '_yoast_wpseo_focuskw' => 'old' );
		$this->assertTrue( Seo_Adapter::write( 7, array( 'description' => 'New description.', 'focusKeyphrase' => '', 'indexing' => 'index' ) ) );
		$this->assertSame( 'New description.', $GLOBALS['sitepilot_test_post_meta'][7]['_yoast_wpseo_metadesc'] );
		$this->assertArrayNotHasKey( '_yoast_wpseo_focuskw', $GLOBALS['sitepilot_test_post_meta'][7] );
		$this->assertSame( '2', $GLOBALS['sitepilot_test_post_meta'][7]['_yoast_wpseo_meta-robots-noindex'] );

		$this->assertTrue( Seo_Adapter::write( 7, array( 'indexing' => 'default' ) ) );
		$this->assertArrayNotHasKey( '_yoast_wpseo_meta-robots-noindex', $GLOBALS['sitepilot_test_post_meta'][7] );
	}

	public function test_rejects_values_wordpress_would_change(): void {
		$this->assertNull( Seo_Adapter::validate( array( 'title' => '%%title%% %%sep%% Guides', 'canonical' => 'https://example.test/a' ) ) );
		$this->assertStringContainsString( 'markup', (string) Seo_Adapter::validate( array( 'title' => 'Hello <b>there</b>' ) ) );
		$this->assertStringContainsString( 'markup', (string) Seo_Adapter::validate( array( 'description' => "Two\nlines" ) ) );
		$this->assertStringContainsString( 'canonical', (string) Seo_Adapter::validate( array( 'canonical' => 'javascript:alert(1)' ) ) );
		$this->assertStringContainsString( 'indexing', (string) Seo_Adapter::validate( array( 'indexing' => 'nofollow' ) ) );
		$this->assertStringContainsString( 'not supported', (string) Seo_Adapter::validate( array( 'ogImage' => 'x' ) ) );
		$this->assertNotNull( Seo_Adapter::validate( array() ) );
	}

	public function test_restores_exact_meta_including_absence(): void {
		$GLOBALS['sitepilot_test_post_meta'][7] = array( '_yoast_wpseo_title' => 'Before' );
		$before = Seo_Adapter::raw_meta( 7 );
		Seo_Adapter::write( 7, array( 'title' => 'After', 'description' => 'Added' ) );
		$this->assertNotSame( $before, Seo_Adapter::raw_meta( 7 ) );

		$this->assertTrue( Seo_Adapter::restore( 7, $before ) );
		$this->assertSame( 'Before', $GLOBALS['sitepilot_test_post_meta'][7]['_yoast_wpseo_title'] );
		$this->assertArrayNotHasKey( '_yoast_wpseo_metadesc', $GLOBALS['sitepilot_test_post_meta'][7] );
	}

	public function test_hash_matches_the_typescript_value_hash(): void {
		// hashGutenbergV2Value() over the same object; see gutenberg-v2-seo.test.ts.
		$values = array_merge( array_fill_keys( Seo_Adapter::FIELDS, '' ), array( 'indexing' => 'default', 'title' => 'Café — “quoted”' ) );
		$this->assertSame( hash( 'sha256', '{"canonical":"","description":"","focusKeyphrase":"","indexing":"default","socialDescription":"","socialTitle":"","title":"Café — “quoted”"}' ), Seo_Adapter::hash( $values ) );
	}
}
