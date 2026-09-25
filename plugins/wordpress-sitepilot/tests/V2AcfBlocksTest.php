<?php
declare( strict_types = 1 );

use PHPUnit\Framework\TestCase;
use SitePilot\V2\Acf_Blocks;
use SitePilot\V2\Block_Policy;

final class V2AcfBlocksTest extends TestCase {

	private const DATA = array(
		'colour'          => 'bg-gray-300',
		'_colour'         => 'field_container_colour',
		'padding_amount'  => 'py-0',
		'_padding_amount' => 'field_container_padding_amount',
		'bottom_border'   => '1',
		'_bottom_border'  => 'field_container_bottom_border',
	);

	protected function setUp(): void {
		$GLOBALS['sitepilot_test_options'] = array();
		Acf_Blocks::reset_cache();
	}

	public function test_discovery_describes_every_field_of_the_block(): void {
		$definition = Acf_Blocks::definition( 'acf/container' );

		$this->assertNotNull( $definition );
		$this->assertTrue( $definition['innerBlocks'] );
		$this->assertTrue( $definition['authorable'] );
		$this->assertMatchesRegularExpression( '/^[a-f0-9]{64}$/', $definition['schemaHash'] );
		$this->assertSame( array( 'colour', 'padding_amount', 'bottom_border' ), array_column( $definition['fields'], 'name' ) );
		$this->assertSame( 'white', $definition['fields'][0]['default'] );
		$this->assertSame( array( 'value' => 'bg-gray-300', 'label' => 'grey' ), $definition['fields'][0]['choices'][1] );
		$this->assertSame( 'true_false', $definition['fields'][2]['type'] );
	}

	public function test_data_must_match_the_field_definitions(): void {
		$this->assertNull( Acf_Blocks::validate_data( 'acf/container', self::DATA ) );
		$this->assertStringContainsString( 'not one of its choices', (string) Acf_Blocks::validate_data( 'acf/container', array_merge( self::DATA, array( 'colour' => 'purple' ) ) ) );
		$this->assertStringContainsString( 'no field called width', (string) Acf_Blocks::validate_data( 'acf/container', array_merge( self::DATA, array( 'width' => 'x', '_width' => 'field_x' ) ) ) );
		$missing_key = self::DATA;
		unset( $missing_key['_colour'] );
		$this->assertStringContainsString( 'missing its field key', (string) Acf_Blocks::validate_data( 'acf/container', $missing_key ) );
		$this->assertStringContainsString( 'right field key', (string) Acf_Blocks::validate_data( 'acf/container', array_merge( self::DATA, array( '_colour' => 'field_other' ) ) ) );
		$this->assertStringContainsString( '0 or 1', (string) Acf_Blocks::validate_data( 'acf/container', array_merge( self::DATA, array( 'bottom_border' => 'maybe' ) ) ) );
	}

	public function test_defaults_come_from_the_field_definitions(): void {
		$this->assertSame(
			array(
				'colour'          => 'bg-white',
				'_colour'         => 'field_container_colour',
				'padding_amount'  => 'py-[80px] md:py-[100px]',
				'_padding_amount' => 'field_container_padding_amount',
				'bottom_border'   => '1',
				'_bottom_border'  => 'field_container_bottom_border',
			),
			Acf_Blocks::normalize_data( 'acf/container', array() )
		);
	}

	public function test_a_block_is_authorable_only_while_its_fixture_is_current(): void {
		$this->assertNotContains( 'acf/container', Block_Policy::authorable_blocks() );
		$this->assertContains( 'acf/container', Block_Policy::fixture_required_blocks() );
		$this->assertSame( 'untested', Acf_Blocks::fixture_status( 'acf/container' )['status'] );

		// Listing the name in the legacy option is not enough for an ACF block.
		update_option( Block_Policy::REVIEWED_OPTION, array( 'acf/container' ) );
		$this->assertNotContains( 'acf/container', Block_Policy::authorable_blocks() );

		$hash = Acf_Blocks::definition( 'acf/container' )['schemaHash'];
		update_option( Acf_Blocks::FIXTURES_OPTION, array( 'acf/container' => array( 'result' => 'passed', 'schemaHash' => $hash, 'acfVersion' => '6.8.3' ) ) );
		$this->assertContains( 'acf/container', Block_Policy::authorable_blocks() );
		$this->assertSame( 'author_when_reviewed', $this->bridge_support( 'acf/container' ) );

		// A changed field group or ACF update turns the block back to kept-only.
		update_option( Acf_Blocks::FIXTURES_OPTION, array( 'acf/container' => array( 'result' => 'passed', 'schemaHash' => str_repeat( 'b', 64 ), 'acfVersion' => '6.8.3' ) ) );
		$this->assertSame( 'stale', Acf_Blocks::fixture_status( 'acf/container' )['status'] );
		$this->assertNotContains( 'acf/container', Block_Policy::authorable_blocks() );
		update_option( Acf_Blocks::FIXTURES_OPTION, array( 'acf/container' => array( 'result' => 'passed', 'schemaHash' => $hash, 'acfVersion' => '6.7.0' ) ) );
		$this->assertSame( 'stale', Acf_Blocks::fixture_status( 'acf/container' )['status'] );

		update_option( Acf_Blocks::FIXTURES_OPTION, array( 'acf/container' => array( 'result' => 'failed', 'schemaHash' => $hash, 'acfVersion' => '6.8.3' ) ) );
		$this->assertSame( 'failed', Acf_Blocks::fixture_status( 'acf/container' )['status'] );
		$this->assertNotContains( 'acf/container', Block_Policy::authorable_blocks() );
	}

	public function test_a_fixture_for_an_old_schema_is_refused(): void {
		$result = Acf_Blocks::record_fixture(
			array(
				'blockName'         => 'acf/container',
				'schemaHash'        => str_repeat( 'c', 64 ),
				'serializedContent' => '',
				'reopenedContent'   => '',
			)
		);
		$this->assertInstanceOf( WP_Error::class, $result );
		$this->assertSame( array(), get_option( Acf_Blocks::FIXTURES_OPTION, array() ) );
	}

	public function test_a_block_that_changes_on_reopen_is_recorded_as_failed(): void {
		$hash    = Acf_Blocks::definition( 'acf/container' )['schemaHash'];
		$content = '<!-- wp:acf/container {"name":"acf/container","data":' . json_encode( self::DATA ) . ',"mode":"preview"} /-->';
		$result  = Acf_Blocks::record_fixture(
			array(
				'blockName'         => 'acf/container',
				'schemaHash'        => $hash,
				'serializedContent' => $content,
				'reopenedContent'   => str_replace( '"mode"', '"align":"","mode"', $content ),
			)
		);
		$this->assertSame( 'failed', $result['status'] );
		$this->assertSame( 'The block changed when the editor reopened it.', $result['message'] );
		$this->assertNotContains( 'acf/container', Block_Policy::authorable_blocks() );
	}

	private function bridge_support( string $name ): string {
		$config = Block_Policy::bridge_config();
		return in_array( $name, $config['reviewedBlocks'], true ) && in_array( $name, $config['fixtureRequiredBlocks'], true ) ? 'author_when_reviewed' : 'preserve_only';
	}
}
