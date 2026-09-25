<?php
/**
 * v2 block authoring policy, read from the generated block manifest.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

/**
 * Loads `block-manifest.json` (generated from GUTENBERG_V2_SUPPORT_MATRIX) and
 * checks that blocks v2 cannot author survive a write byte-for-byte.
 */
final class Block_Policy {

	public const SOURCE_BLOCK = 'sitepilot/source-block';

	/** Per-site list of fixture-gated blocks that passed their native fixture. */
	public const REVIEWED_OPTION = 'sitepilot_v2_reviewed_blocks';

	/**
	 * Same token grammar as WordPress core's WP_Block_Parser::next_token().
	 */
	private const TOKEN_PATTERN = '/<!--\s+(?P<closer>\/)?wp:(?P<namespace>[a-z][a-z0-9_-]*\/)?(?P<name>[a-z][a-z0-9_-]*)\s+(?P<attrs>{(?:(?:[^}]+|}+(?=})|(?!}\s+\/?-->).)*+)?}\s+)?(?P<void>\/)?-->/s';

	/** @var array<string, mixed>|null */
	private static ?array $manifest = null;

	/** @return array<string, mixed> */
	public static function manifest(): array {
		if ( null === self::$manifest ) {
			$raw      = file_get_contents( __DIR__ . '/block-manifest.json' );
			$decoded  = is_string( $raw ) ? json_decode( $raw, true ) : null;
			self::$manifest = is_array( $decoded ) && isset( $decoded['blocks'] ) && is_array( $decoded['blocks'] )
				? $decoded
				: array( 'blocks' => array() );
		}
		return self::$manifest;
	}

	/** @return array<string, array<string, mixed>> */
	private static function rules(): array {
		$rules = array();
		foreach ( self::manifest()['blocks'] as $entry ) {
			if ( is_array( $entry ) && isset( $entry['name'] ) ) {
				$rules[ (string) $entry['name'] ] = $entry;
			}
		}
		return $rules;
	}

	/**
	 * Fixture-gated blocks that passed their native fixture here. ACF blocks
	 * count only while their fixture record matches the current field schema
	 * and ACF version, so a listed name alone never enables one.
	 *
	 * @return array<int, string>
	 */
	public static function reviewed_blocks(): array {
		$value  = function_exists( 'get_option' ) ? get_option( self::REVIEWED_OPTION, array() ) : array();
		$listed = is_array( $value ) ? array_values( array_filter( array_map( 'strval', $value ) ) ) : array();
		$listed = array_values( array_filter( $listed, static fn ( string $name ): bool => ! Acf_Blocks::is_acf_block( $name ) ) );
		return array_values( array_unique( array_merge( $listed, Acf_Blocks::passing_blocks() ) ) );
	}

	/**
	 * Blocks v2 may author here: the release matrix plus fixture-gated blocks
	 * this site has reviewed.
	 *
	 * @return array<int, string>
	 */
	public static function authorable_blocks(): array {
		$reviewed = self::reviewed_blocks();
		$names    = array();
		foreach ( self::rules() as $name => $entry ) {
			if ( 'author' === ( $entry['mode'] ?? '' ) || ( 'fixture_required' === ( $entry['mode'] ?? '' ) && in_array( $name, $reviewed, true ) ) ) {
				$names[] = $name;
			}
		}
		return array_values( array_unique( array_merge( $names, Acf_Blocks::passing_blocks() ) ) );
	}

	/**
	 * Blocks that need a per-site fixture: the matrix's fixture-gated blocks
	 * and every ACF block on the site.
	 *
	 * @return array<int, string>
	 */
	public static function fixture_required_blocks(): array {
		$names = array();
		foreach ( self::rules() as $name => $entry ) {
			if ( 'fixture_required' === ( $entry['mode'] ?? '' ) ) {
				$names[] = $name;
			}
		}
		return array_values( array_unique( array_merge( $names, array_keys( Acf_Blocks::definitions() ) ) ) );
	}

	public static function required_parent( string $name ): ?string {
		$rules  = self::rules();
		$parent = $rules[ $name ]['parent'] ?? null;
		return is_string( $parent ) && '' !== $parent ? $parent : null;
	}

	/**
	 * Config passed to the editor bridge so it uses the same lists.
	 *
	 * @return array<string, mixed>
	 */
	public static function bridge_config(): array {
		return array(
			'authorBlocks'          => array_values(
				array_filter(
					array_keys( self::rules() ),
					static fn ( string $name ): bool => 'author' === ( self::rules()[ $name ]['mode'] ?? '' )
				)
			),
			'fixtureRequiredBlocks' => self::fixture_required_blocks(),
			'reviewedBlocks'        => self::reviewed_blocks(),
			'sourceBlock'           => self::SOURCE_BLOCK,
			'acfBlocks'             => Acf_Blocks::described_with_status(),
		);
	}

	/**
	 * Splits serialized content into a block tree that records each block's
	 * exact byte range, mirroring WP_Block_Parser's handling of nesting,
	 * void blocks, stray closers and unclosed openers.
	 *
	 * @return array<int, array{name: ?string, start: int, end: int, children: array<int, mixed>}>
	 */
	public static function tokenize( string $content ): array {
		$roots  = array();
		$stack  = array();
		$offset = 0;
		$length = strlen( $content );
		$add    = static function ( array $node ) use ( &$stack, &$roots ): void {
			if ( empty( $stack ) ) {
				$roots[] = $node;
				return;
			}
			$stack[ count( $stack ) - 1 ]['children'][] = $node;
		};
		$add_freeform = static function ( int $start, int $end ) use ( &$roots, $content ): void {
			if ( $end > $start && '' !== trim( substr( $content, $start, $end - $start ) ) ) {
				$roots[] = array( 'name' => null, 'start' => $start, 'end' => $end, 'children' => array() );
			}
		};

		while ( $offset <= $length && preg_match( self::TOKEN_PATTERN, $content, $match, PREG_OFFSET_CAPTURE, $offset ) ) {
			$start     = (int) $match[0][1];
			$end       = $start + strlen( (string) $match[0][0] );
			$namespace = isset( $match['namespace'] ) && -1 !== $match['namespace'][1] ? (string) $match['namespace'][0] : '';
			$name      = ( '' === $namespace ? 'core/' : $namespace ) . (string) $match['name'][0];
			$is_closer = isset( $match['closer'] ) && -1 !== $match['closer'][1] && '' !== $match['closer'][0];
			$is_void   = isset( $match['void'] ) && -1 !== $match['void'][1] && '' !== $match['void'][0];

			if ( empty( $stack ) ) {
				$add_freeform( $offset, $start );
			}
			if ( $is_void && ! $is_closer ) {
				$add( array( 'name' => $name, 'start' => $start, 'end' => $end, 'children' => array() ) );
			} elseif ( ! $is_closer ) {
				$stack[] = array( 'name' => $name, 'start' => $start, 'end' => $end, 'children' => array() );
			} elseif ( ! empty( $stack ) ) {
				$frame        = array_pop( $stack );
				$frame['end'] = $end;
				$add( $frame );
			}
			$offset = $end;
		}
		while ( ! empty( $stack ) ) {
			$frame        = array_pop( $stack );
			$frame['end'] = $length;
			$add( $frame );
			$offset = $length;
		}
		if ( $offset < $length ) {
			$add_freeform( $offset, $length );
		}
		return $roots;
	}

	/**
	 * Collects the exact bytes of every outermost block that v2 cannot author.
	 *
	 * @param array<int, array<string, mixed>> $nodes Tokenized nodes.
	 * @param array<int, string>               $authorable Authorable block names.
	 * @return array<int, string>
	 */
	private static function preserved_slices( string $content, array $nodes, array $authorable ): array {
		$slices = array();
		foreach ( $nodes as $node ) {
			$name = $node['name'];
			if ( null !== $name && in_array( $name, $authorable, true ) ) {
				$slices = array_merge( $slices, self::preserved_slices( $content, $node['children'], $authorable ) );
				continue;
			}
			$slices[] = substr( $content, (int) $node['start'], (int) $node['end'] - (int) $node['start'] );
		}
		return $slices;
	}

	/**
	 * Every block v2 cannot author in the new content must be an unchanged
	 * copy of a block in the source, used at most once. New drafts have no
	 * source, so they may only contain authorable blocks.
	 *
	 * @return array{name: ?string}|null The first offending block, or null.
	 */
	public static function find_unpreserved_block( string $content, ?string $source_content ): ?array {
		$authorable = self::authorable_blocks();
		$available  = array();
		if ( null !== $source_content ) {
			foreach ( self::preserved_slices( $source_content, self::tokenize( $source_content ), $authorable ) as $slice ) {
				$available[ $slice ] = ( $available[ $slice ] ?? 0 ) + 1;
			}
		}
		foreach ( self::preserved_slices( $content, self::tokenize( $content ), $authorable ) as $index => $slice ) {
			if ( ( $available[ $slice ] ?? 0 ) < 1 ) {
				$tokens = self::tokenize( $slice );
				return array( 'name' => $tokens[0]['name'] ?? null );
			}
			--$available[ $slice ];
		}
		return null;
	}
}
