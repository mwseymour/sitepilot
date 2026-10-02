<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Post_Terms;

final class PostTermsTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['sitepilot_test_denied_caps'] = array();
		$GLOBALS['sitepilot_test_terms']        = array(
			'category' => array(
				new WP_Term( 1, 'uncategorized', 'Uncategorized' ),
				new WP_Term( 3, 'news', 'News &amp; views' ),
				new WP_Term( 4, 'travel', 'Travel' ),
			),
			'post_tag' => array(
				new WP_Term( 9, 'walking', 'Walking' ),
				new WP_Term( 10, 'lakes', 'Lakes' ),
			),
		);
		$GLOBALS['sitepilot_test_object_terms']                       = array( 12 => array( 'category' => array( 3 ) ) );
		$GLOBALS['sitepilot_test_options']['default_category'] = 1;
	}

	protected function tearDown(): void {
		unset( $GLOBALS['sitepilot_test_terms'], $GLOBALS['sitepilot_test_object_terms'], $GLOBALS['sitepilot_test_options']['default_category'] );
		$GLOBALS['sitepilot_test_denied_caps'] = array();
		parent::tearDown();
	}

	public function test_posts_offer_categories_and_tags_and_pages_none(): void {
		$this->assertSame( array( 'taxonomies' => array( 'category', 'post_tag' ) ), Post_Terms::describe( 'post' ) );
		$this->assertNull( Post_Terms::describe( 'page' ) );
	}

	public function test_reads_a_posts_terms_and_hashes_them_as_the_app_does(): void {
		$terms = Post_Terms::read( 12 );

		$this->assertSame( array( 'category' => array( array( 'id' => 3, 'name' => 'News & views' ) ), 'post_tag' => array() ), $terms );
		// hashGutenbergV2Value({ category: [{ id: 3, name: "News & views" }], post_tag: [] }) in TypeScript.
		$this->assertSame( 'fc0fd43e22d88d2ff8c1821e08c41d6897e4a1528d37c9dcef4403ed4663f078', Post_Terms::hash( $terms ) );
	}

	public function test_prepares_the_terms_a_post_ends_with(): void {
		$after = Post_Terms::prepare( array( 'post_tag' => array( array( 'id' => 10, 'name' => 'Lakes' ), array( 'id' => 9, 'name' => 'Walking' ) ) ), 12 );

		$this->assertSame(
			array(
				'category' => array( array( 'id' => 3, 'name' => 'News & views' ) ),
				'post_tag' => array( array( 'id' => 9, 'name' => 'Walking' ), array( 'id' => 10, 'name' => 'Lakes' ) ),
			),
			$after
		);
		// A new draft keeps WordPress's default category unless one is set.
		$this->assertSame( array( array( 'id' => 1, 'name' => 'Uncategorized' ) ), Post_Terms::prepare( array( 'post_tag' => array( array( 'id' => 9 ) ) ), null )['category'] );
	}

	public function test_refuses_unknown_terms_no_category_and_no_permission(): void {
		$this->assertIsString( Post_Terms::prepare( array( 'post_tag' => array( array( 'id' => 99 ) ) ), 12 ) );
		$this->assertIsString( Post_Terms::prepare( array( 'category' => array() ), 12 ) );
		$this->assertIsString( Post_Terms::prepare( array( 'nav_menu' => array( array( 'id' => 3 ) ) ), 12 ) );
		$GLOBALS['sitepilot_test_denied_caps'] = array( 'assign_post_tags' );
		$this->assertIsString( Post_Terms::prepare( array( 'post_tag' => array( array( 'id' => 9 ) ) ), 12 ) );
	}

	public function test_writes_and_restores(): void {
		$before = Post_Terms::read( 12 );

		$this->assertTrue( Post_Terms::write( 12, array( 'category' => array( array( 'id' => 4 ) ), 'post_tag' => array( array( 'id' => 9 ) ) ) ) );
		$this->assertSame( array( 4 ), array_column( Post_Terms::read( 12 )['category'], 'id' ) );
		$this->assertSame( array( 9 ), array_column( Post_Terms::read( 12 )['post_tag'], 'id' ) );

		$this->assertTrue( Post_Terms::restore( 12, $before ) );
		$this->assertSame( $before, Post_Terms::read( 12 ) );
	}
}
